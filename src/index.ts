import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface AgentConfig {
  agentId: string;
  agents: Record<string, string>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, '..', 'config.json');

if (!existsSync(configPath)) {
  console.error('config.json not found — copy config.example.json to config.json and edit it');
  process.exit(1);
}

const config: AgentConfig = JSON.parse(readFileSync(configPath, 'utf-8'));

// ---------------------------------------------------------------------------
// A2A JSON-RPC 2.0 client
// ---------------------------------------------------------------------------

interface MemoryRef {
  id: string;
  hint?: string;
  vault?: string;
}

interface A2APart {
  text?: string;
}

interface A2AArtifact {
  artifactId?: string;
  parts?: A2APart[];
}

interface A2ATaskStatus {
  state?: string;
}

interface A2ATask {
  id?: string;
  contextId?: string;
  status?: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  metadata?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: {
    task?: A2ATask;
    statusUpdate?: { taskId?: string; status?: A2ATaskStatus };
  };
  error?: { code: number; message: string; data?: unknown };
}

interface AgentResult {
  text: string;
  refs: MemoryRef[];
}

/**
 * Parse an agent selector of the form "<name>" or "<name>@<channel>".
 * The suffix, when present, is a lowercased hint the recipient agent can use
 * to route the request into a specific channel's active session (e.g.
 * "perry@slack" → inject into Perry's live Slack session rather than
 * spawning a fresh isolated context). Case-insensitive on both sides of @.
 *
 * Per design thread with CC (2026-04-09): the suffix is carried in A2A
 * `message.metadata.targetGroup`, which is the protocol's declared
 * extension point. Unknown to agents that don't care; opt-in for agents
 * that do. No breaking change.
 */
function parseAgentSelector(raw: string): {
  name: string;
  targetGroup: string | null;
} {
  const at = raw.indexOf('@');
  if (at < 0) return { name: raw, targetGroup: null };
  return {
    name: raw.slice(0, at),
    targetGroup: raw.slice(at + 1).toLowerCase(),
  };
}

function buildRequest(
  message: string,
  contextId: string,
  memoryRefs: MemoryRef[],
  targetGroup: string | null,
): {
  jsonrpc: '2.0';
  method: 'message/stream';
  params: Record<string, unknown>;
  id: string;
} {
  const msg: Record<string, unknown> = {
    role: 'user',
    messageId: randomUUID(),
    contextId,
    parts: [{ text: message }],
  };
  const metadata: Record<string, unknown> = {};
  if (memoryRefs.length > 0) metadata['memoryRefs'] = memoryRefs;
  if (targetGroup) metadata['targetGroup'] = targetGroup;
  if (Object.keys(metadata).length > 0) {
    msg.metadata = metadata;
  }
  return {
    jsonrpc: '2.0',
    method: 'message/stream',
    params: { message: msg },
    id: randomUUID(),
  };
}

function extractText(task: A2ATask | undefined): string {
  if (!task) return '';
  return (task.artifacts ?? [])
    .flatMap((a) => a.parts ?? [])
    .map((p) => p.text ?? '')
    .filter((t) => t.length > 0)
    .join('\n');
}

/**
 * Pull memoryRefs out of a task's metadata block. Tolerant of
 * missing/malformed shapes — returns empty array rather than throwing.
 */
function extractMemoryRefs(task: A2ATask | undefined): MemoryRef[] {
  if (!task?.metadata) return [];
  const raw = task.metadata['memoryRefs'];
  if (!Array.isArray(raw)) return [];
  const refs: MemoryRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const id = obj['id'];
    if (typeof id !== 'string' || !id) continue;
    const ref: MemoryRef = { id };
    if (typeof obj['hint'] === 'string') ref.hint = obj['hint'] as string;
    if (typeof obj['vault'] === 'string') ref.vault = obj['vault'] as string;
    refs.push(ref);
  }
  return refs;
}

async function readSSEStream(response: Response): Promise<AgentResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: AgentResult = { text: '', refs: [] };
  let lastError: { code: number; message: string } | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const envelope: JsonRpcResponse = JSON.parse(line.slice(6));
        if (envelope.error) {
          lastError = envelope.error;
          continue;
        }
        const task = envelope.result?.task;
        if (task?.status?.state === 'completed') {
          result = { text: extractText(task), refs: extractMemoryRefs(task) };
        } else if (task?.status?.state === 'failed') {
          lastError = {
            code: -1,
            message: `Task failed: ${JSON.stringify(task.status)}`,
          };
        }
      } catch {
        // skip malformed events
      }
    }
  }

  if (!result.text && lastError) {
    throw new Error(`A2A error ${lastError.code}: ${lastError.message}`);
  }
  return result;
}

async function callAgent(
  agentUrl: string,
  message: string,
  sessionId: string,
  memoryRefs: MemoryRef[],
  targetGroup: string | null,
): Promise<AgentResult> {
  const request = buildRequest(message, sessionId, memoryRefs, targetGroup);

  const response = await fetch(agentUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream, application/json',
      'X-Agent-ID': config.agentId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`A2A request failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return await readSSEStream(response);
  }

  // Non-streaming JSON response
  const envelope = (await response.json()) as JsonRpcResponse;
  if (envelope.error) {
    throw new Error(`A2A error ${envelope.error.code}: ${envelope.error.message}`);
  }
  const task = envelope.result?.task;
  return { text: extractText(task), refs: extractMemoryRefs(task) };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'a2a-mcp',
  version: '1.0.0',
});

server.tool(
  'list_agents',
  'List available A2A agents that can be called',
  {},
  async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          Object.entries(config.agents).map(([name, url]) => ({ name, url })),
          null,
          2,
        ),
      },
    ],
  }),
);

server.tool(
  'ask_agent',
  'Send a message to a named A2A agent and return its response. Optionally attach memory references (AMP memory IDs) that travel with the message so the agent can fetch shared context before answering. The agent name supports an optional @<channel> suffix (case-insensitive) — e.g. "perry@slack" — which asks the recipient agent to run the request inside the named channel\'s primary live session rather than spawning a fresh isolated context. The suffix rides along as A2A message.metadata.targetGroup and is ignored by agents that don\'t implement cross-channel routing.',
  {
    agent: z.string().describe('Agent name — use list_agents to see available agents'),
    message: z.string().describe('Message to send to the agent'),
    session_id: z
      .string()
      .optional()
      .describe('Session ID for multi-turn conversations — omit to start a new session'),
    memory_refs: z
      .union([
        z.array(
          z.object({
            id: z.string().describe('AMP memory ID to reference'),
            hint: z
              .string()
              .optional()
              .describe('Optional subject hint for re-resolving if the ID has been superseded'),
            vault: z
              .string()
              .optional()
              .describe('Optional vault hint (team/org/exchange/private)'),
          }),
        ),
        z
          .string()
          .describe(
            'JSON-encoded array of memref objects — accepted for MCP clients that stringify array parameters',
          ),
      ])
      .optional()
      .describe(
        'Memory references to attach to the message. The agent will fetch each memory before answering. Use for handoffs that need shared context without inlining the content. Accepts either a structured array or a JSON-encoded string.',
      ),
  },
  async ({ agent, message, session_id, memory_refs }) => {
    // Split "<name>@<channel>" if present. The bare name drives URL lookup;
    // the channel suffix (lowercased) rides along as metadata for the
    // recipient's cross-channel routing logic.
    const { name: agentName, targetGroup } = parseAgentSelector(agent);
    const url = config.agents[agentName];
    if (!url) {
      const available = Object.keys(config.agents).join(', ');
      return {
        content: [
          { type: 'text', text: `Unknown agent "${agentName}". Available: ${available}` },
        ],
        isError: true,
      };
    }

    const sessionId = session_id ?? randomUUID();

    // Normalize memory_refs: the MCP client of some hosts (Claude Code
    // included) stringifies array-of-object parameters before dispatch, so
    // the schema accepts either a structured array or a JSON-encoded
    // string. Parse the string form here.
    let refs: MemoryRef[] = [];
    if (typeof memory_refs === 'string') {
      try {
        const parsed = JSON.parse(memory_refs);
        if (Array.isArray(parsed)) {
          refs = parsed.filter(
            (r): r is MemoryRef =>
              !!r && typeof r === 'object' && typeof (r as MemoryRef).id === 'string',
          );
        }
      } catch {
        return {
          content: [
            {
              type: 'text',
              text: `Error: memory_refs string was not valid JSON. Pass a structured array or a JSON-encoded array of {id, hint?, vault?} objects.`,
            },
          ],
          isError: true,
        };
      }
    } else if (Array.isArray(memory_refs)) {
      refs = memory_refs;
    }

    try {
      const result = await callAgent(url, message, sessionId, refs, targetGroup);
      const content: Array<{ type: 'text'; text: string }> = [
        { type: 'text', text: result.text || '(no response)' },
      ];
      if (result.refs.length > 0) {
        const refsSummary = result.refs
          .map((r) => `  - ${r.id}${r.hint ? ` — ${r.hint}` : ''}`)
          .join('\n');
        content.push({
          type: 'text',
          text: `[memory refs returned by ${agent}]\n${refsSummary}`,
        });
      }
      return { content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error calling agent "${agent}": ${msg}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
