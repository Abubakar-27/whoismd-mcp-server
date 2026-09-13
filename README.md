# whoismd-mcp-server

Open-source native **MCP** (Model Context Protocol) server driver for
[WhoisMD](https://whoismd.com) real-time internet intelligence routing.

This server is an **unprivileged client driver**: it contains no engine code,
no database access, and no proprietary historical data. Every tool call is
delegated to the public WhoisMD REST API (`/v1/intel/lookup`) and is metered
against your own `pg_live_...` API key credits.

## Tools

| Tool             | Description                                                            |
| ---------------- | ---------------------------------------------------------------------- |
| `whoismd_lookup` | Full domain intelligence lookup — WHOIS/RDAP, DNS (A/AAAA/MX/NS/TXT), IP resolution, deterministic 0–100 threat risk score. |
| `whoismd_bulk`   | Batch lookup of up to 100 domains with bounded concurrency (5).         |

Each lookup returns `riskScore`, `riskLevel`, `aiCleanSummary`, `creditsSpent`,
`creditsRemaining`, and the full `data` report. Calls are credit-metered by the
API key holder.

## Requirements

- Node.js **>= 20** (native `fetch` required)
- A WhoisMD API key (`pg_live_...`) — generate one from the WhoisMD dashboard
  after signup. Keys are scoped to the `live_lookup` tier and rate-limited to
  20 requests/minute.

## Running

### Build & run directly

```bash
npm install
npm run build
WHOISMD_API_KEY=pg_live_... node dist/index.js
```

The server speaks MCP over **stdio** (JSON-RPC), so it must be launched by an
MCP-capable client — not invoked interactively.

### Development

```bash
npm run dev          # tsx watch, no build step
npm run typecheck    # tsc --noEmit
```

## Environment variables

| Variable            | Default                      | Required | Description                                  |
| ------------------- | ---------------------------- | -------- | -------------------------------------------- |
| `WHOISMD_API_KEY`   | —                            | yes      | Your `pg_live_...` API key. Never hard-code. |
| `WHOISMD_API_BASE`  | `https://whoismd.com/api`    | no       | Overrides the API base URL (for testing).    |

## Client configuration

### Cursor

`.cursor/mcp.json` in your project (or the global Cursor MCP config):

```json
{
  "mcpServers": {
    "whoismd": {
      "command": "npx",
      "args": ["-y", "whoismd-mcp-server"],
      "env": {
        "WHOISMD_API_KEY": "pg_live_xxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

To point at a local checkout instead:

```json
{
  "mcpServers": {
    "whoismd": {
      "command": "node",
      "args": ["/absolute/path/to/whoismd-mcp-server/dist/index.js"],
      "env": {
        "WHOISMD_API_KEY": "pg_live_xxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### Windsurf

Windsurf uses the same MCP JSON shape. Add it via
`~/.codeium/windsurf/mcp_config.json`, or through **Settings → MCP → Add**:

```json
{
  "mcpServers": {
    "whoismd": {
      "command": "npx",
      "args": ["-y", "whoismd-mcp-server"],
      "env": {
        "WHOISMD_API_KEY": "pg_live_xxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "whoismd": {
      "command": "npx",
      "args": ["-y", "whoismd-mcp-server"],
      "env": {
        "WHOISMD_API_KEY": "pg_live_xxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### Generic clients

```bash
npx -y whoismd-mcp-server
# or
node /absolute/path/to/whoismd-mcp-server/dist/index.js
```

The API key can also be exported in the environment of the client process instead
of the config `env` block — how you inject it is up to your client's security
model. Prefer config-injected `env`, never shell history or commit.

## Security

- The API key is consumed from the environment / client config **only**; it is
  never embedded, logged, or written to disk by this server.
- All traffic goes to the public WhoisMD endpoint over HTTPS.
- This driver is deliberately read-only and unprivileged: no private database,
  no reverse footprint history, no admin surface.

## License

MIT