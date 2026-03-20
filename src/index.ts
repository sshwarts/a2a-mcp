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
// A2A client
// ---------------------------------------------------------------------------

interface A2ATask {
  id: string;
  sessionId: string;
  message: {
    role: string;
    parts: Array<{ type: string; text: string }>;
  };
}

interface A2ATaskEvent {
  id: string;
  status?: { state: string };
  artifacts?: Array<{
    parts: Array<{ type: string; text?: string }>;
  }>;
}

function buildTask(message: string, sessionId: string): A2ATask {
  return {
    id: randomUUID(),
    sessionId,
    message: {
      role: 'user',
      parts: [{ type: 'text', text: message }],
    },
  };
}

function extractText(event: A2ATaskEvent): string {
  return (event.artifacts ?? [])
    .flatMap((a) => a.parts)
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('\n');
}

async function readSSEStream(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event: A2ATaskEvent = JSON.parse(line.slice(6));
        if (event.status?.state === 'completed') {
          result = extractText(event);
        }
      } catch {
        // skip malformed events
      }
    }
  }

  return result;
}

async function callAgent(agentUrl: string, message: string, sessionId: string): Promise<string> {
  const task = buildTask(message, sessionId);

  const response = await fetch(agentUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'X-Agent-ID': config.agentId,
    },
    body: JSON.stringify(task),
  });

  if (!response.ok) {
    throw new Error(`A2A request failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return await readSSEStream(response);
  }

  // Fallback: plain JSON response (non-streaming agents)
  const data = await response.json() as A2ATaskEvent;
  return extractText(data);
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
  'Send a message to a named A2A agent and return its response',
  {
    agent: z.string().describe('Agent name — use list_agents to see available agents'),
    message: z.string().describe('Message to send to the agent'),
    session_id: z
      .string()
      .optional()
      .describe('Session ID for multi-turn conversations — omit to start a new session'),
  },
  async ({ agent, message, session_id }) => {
    const url = config.agents[agent];
    if (!url) {
      const available = Object.keys(config.agents).join(', ');
      return {
        content: [
          { type: 'text', text: `Unknown agent "${agent}". Available: ${available}` },
        ],
        isError: true,
      };
    }

    const sessionId = session_id ?? randomUUID();

    try {
      const result = await callAgent(url, message, sessionId);
      return {
        content: [{ type: 'text', text: result || '(no response)' }],
      };
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
