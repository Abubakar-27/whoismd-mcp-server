/**
 * whoismd-mcp-server
 * =============================================================================
 * Open-source native MCP server driver for WhoisMD real-time internet
 * intelligence routing.
 *
 * Spec-compliant Model Context Protocol server exposing WhoisMD's core
 * intelligence tools to external LLMs, AI agents (Claude, ChatGPT), and
 * developer IDE frameworks (Cursor, Windsurf) via JSON-RPC over Standard I/O.
 *
 * Unlike the embedded private MCP server shipped inside the WhoisMD monorepo,
 * this public driver is an UNPRIVILEGED CLIENT: it holds no engine code, no
 * database access, and no reverse-pivot history. Every tool call is delegated
 * to the public WhoisMD REST API and is metered against the caller's own
 * `pg_live_...` API key credits.
 *
 * Exposed tools:
 *   - whoismd_lookup  : Full domain intelligence lookup (WHOIS/RDAP + DNS + risk)
 *   - whoismd_bulk    : Batch lookup of up to 100 domains (bounded concurrency)
 *
 * Security posture:
 *   - The API key is NEVER embedded; it is read from the WHOISMD_API_KEY
 *     environment variable at runtime (or injected by the MCP client
 *     configuration). Treat it like a password.
 *   - The server only ever talks to the public endpoint over HTTPS
 *     (default: https://whoismd.com/api), overridable via WHOISMD_API_BASE.
 *
 * Transport: stdio (Standard I/O) — the default for IDE / local agent use.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

// =============================================================================
// Configuration
// =============================================================================

const API_BASE = (process.env.WHOISMD_API_BASE ?? "https://whoismd.com/api").replace(/\/+$/, "");
const LOOKUP_PATH = `${API_BASE}/v1/intel/lookup`;
const BULK_PATH = `${API_BASE}/v1/intel/bulk`;
const API_KEY = process.env.WHOISMD_API_KEY ?? "";
const BULK_CONCURRENCY = 5;

// =============================================================================
// Public API client (unprivileged — no engine, no database)
// =============================================================================

export interface LookupCallResult {
  domain: string;
  cached: boolean;
  riskScore: number;
  riskLevel: string;
  aiCleanSummary: string;
  creditsSpent: number;
  creditsRemaining: number;
  data: Record<string, unknown>;
}

export class WhoisMdApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WhoisMdApiError";
  }
}

function resolveKey(): string {
  if (API_KEY.length > 0 && API_KEY.startsWith("pg_live_")) return API_KEY;
  throw new WhoisMdApiError(
    "API key is not configured. Set WHOISMD_API_KEY to a pg_live_... key (e.g. generated from the WhoisMD dashboard).",
    0,
  );
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function lookupDomain(domain: string): Promise<LookupCallResult> {
  const apiKey = resolveKey();
  const res = await fetch(LOOKUP_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ domain }),
  });

  const payload = await parseJson(res);
  if (!res.ok) {
    const detail =
      payload && typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error: unknown }).error)
        : res.statusText;
    throw new WhoisMdApiError(
      `Lookup failed for "${domain}" (HTTP ${res.status}): ${detail}`,
      res.status,
    );
  }

  if (payload === null || typeof payload !== "object") {
    throw new WhoisMdApiError(`Lookup returned an unexpected payload for "${domain}"`, 0);
  }

  return payload as LookupCallResult;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runNext(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runNext()),
  );
  return results;
}

// =============================================================================
// Tool input schemas (Zod — the MCP SDK accepts Zod schemas natively)
// =============================================================================

const lookupSchema = {
  domain: z
    .string()
    .min(1, "Domain must not be empty")
    .max(253, "Domain exceeds the maximum RFC 1035 length of 253 characters")
    .describe("The domain name to analyze (e.g. 'example.com')"),
};

const bulkSchema = {
  domains: z
    .array(z.string().min(1).max(253))
    .min(1, "Provide at least one domain")
    .max(100, "Maximum 100 domains per bulk request")
    .describe("Array of domain names to analyze in batch"),
};

// =============================================================================
// Server factory
// =============================================================================

/**
 * Creates and configures the MCP server instance with all WhoisMD tools.
 * The caller is responsible for calling `server.connect(transport)` to start
 * listening.
 */
export function createWhoisMdMcpServer(): McpServer {
  const server = new McpServer({
    name: "whoismd-intel",
    version: "1.0.0",
  });

  // -------------------------------------------------------------------------
  // Tool: whoismd_lookup
  // -------------------------------------------------------------------------
  server.tool(
    "whoismd_lookup",
    "Perform a full domain intelligence lookup against the public WhoisMD API: " +
      "WHOIS/RDAP registration data, DNS records (A, AAAA, MX, NS, TXT), " +
      "SSRF-safe IP resolution, and a deterministic 0-100 threat risk score. " +
      "Returns a comprehensive JSON report.",
    lookupSchema,
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const { domain } = args;
      try {
        const report = await lookupDomain(domain);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: whoismd_bulk
  // -------------------------------------------------------------------------
  server.tool(
    "whoismd_bulk",
    "Run batch domain intelligence lookups for up to 100 distinct domains via " +
      "the public WhoisMD API. Each entry is analyzed concurrently with bounded " +
      "parallelism. Returns per-domain success/failure results with risk scores.",
    bulkSchema,
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const { domains } = args;
      try {
        const results = await mapLimit(domains, BULK_CONCURRENCY, async (domain) => {
          try {
            const report = await lookupDomain(domain);
            return {
              domain,
              ok: true,
              riskScore: report.riskScore,
              riskLevel: report.riskLevel,
              aiCleanSummary: report.aiCleanSummary,
              creditsSpent: report.creditsSpent,
              creditsRemaining: report.creditsRemaining,
              data: report.data,
            };
          } catch (error) {
            return {
              domain,
              ok: false,
              error: errorMessage(error),
            };
          }
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ count: results.length, results }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

// =============================================================================
// Standalone entry point
// =============================================================================

/**
 * Starts the MCP server over stdio transport. Designed to be invoked as a
 * standalone process by IDE tooling or AI agent runtimes, e.g.:
 *
 *   node dist/index.js
 *   { "command": "node", "args": ["/path/to/whoismd-mcp-server/dist/index.js"] }
 */
export async function startMcpStdioServer(): Promise<void> {
  const server = createWhoisMdMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[whoismd-mcp] WhoisMD MCP server listening on stdio");
}

// =============================================================================
// Helpers
// =============================================================================

function errorMessage(error: unknown): string {
  if (error instanceof WhoisMdApiError) return error.message;
  if (error instanceof Error) return `Unexpected error: ${error.message}`;
  return "An unexpected error occurred.";
}

// When invoked directly as a script, start the stdio server.
const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryUrl !== null && entryUrl === import.meta.url) {
  startMcpStdioServer().catch((error) => {
    console.error("[whoismd-mcp] Fatal startup error:", error);
    process.exit(1);
  });
}