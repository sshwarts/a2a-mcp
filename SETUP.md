# A2A MCP — Setup Guide

General-purpose MCP adapter for calling A2A agents. Configure who you are and who you can reach via `config.json`.

## Prerequisites

```bash
npm install
npm run build
cp config.example.json config.json
# Edit config.json — set your agentId and the agents you want to call
```

## config.json

```json
{
  "agentId": "claude-code",
  "agents": {
    "my-agent": "http://localhost:41241"
  }
}
```

- **`agentId`** — identifies you to the agents you call (`X-Agent-ID` header). Use something meaningful: `claude-code`, `cursor`, `windsurf`, etc.
- **`agents`** — name → A2A endpoint URL. Add as many as you like.

---

## Adding to Claude Code

MCP servers for Claude Code are configured in `~/.claude/mcp.json` (global, all projects) or `.mcp.json` in a project directory (project-scoped).

**Global (`~/.claude/mcp.json`):**
```json
{
  "mcpServers": {
    "a2a-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/A2A_MCP/dist/index.js"]
    }
  }
}
```

Restart Claude Code after adding. The tools `list_agents` and `ask_agent` will appear automatically.

---

## Adding to Cursor

Cursor reads MCP config from `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in a project.

```json
{
  "mcpServers": {
    "a2a-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/A2A_MCP/dist/index.js"]
    }
  }
}
```

Set `"agentId": "cursor"` in your `config.json` so the target agent knows who's calling. Restart Cursor after adding.

---

## Adding to Windsurf

Windsurf MCP config lives at `~/.codeium/windsurf/mcp_config.json`.

```json
{
  "mcpServers": {
    "a2a-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/A2A_MCP/dist/index.js"]
    }
  }
}
```

Set `"agentId": "windsurf"` in `config.json`. Restart Windsurf after adding.

---

## Tools exposed

Once connected, two tools are available in any host:

| Tool | Description |
|------|-------------|
| `list_agents` | Returns available agents from config |
| `ask_agent` | Sends a message to a named agent and returns the response |

### ask_agent parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent` | string | yes | Agent name (from `list_agents`) |
| `message` | string | yes | Message to send |
| `session_id` | string | no | Reuse to maintain conversation context across calls |

---

## A2A protocol

Outbound requests use a simplified A2A envelope:

```
POST {agentUrl}
X-Agent-ID: {your agentId}
Content-Type: application/json
Accept: text/event-stream

{
  "id": "<uuid>",
  "sessionId": "<uuid>",
  "message": {
    "role": "user",
    "parts": [{ "type": "text", "text": "..." }]
  }
}
```

Response is an SSE stream. The adapter waits for a `status.state === "completed"` event and returns the artifact text to the calling tool.

Agents that respond with plain JSON (non-streaming) are also supported as a fallback.

---

## Agent web dashboards

A2A-compatible agents may expose a web dashboard for monitoring message traffic. Consult the agent's documentation for the URL and any required token.
