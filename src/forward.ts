/**
 * buzzmeter core: a forwarding client for the hosted
 * social-pulse MCP server.
 *
 * Nothing about trending topics, mentions or sentiment
 * is computed here. tools/list is answered from the
 * literal definitions below, which reproduce a live
 * capture of the upstream server word for word (name,
 * description and inputSchema exactly as captured; the
 * capture carries NO title keys, and two tools --
 * trending_topics and emerging_terms -- carry no
 * `required` key, so none is served for them). A
 * tools/call travels upstream over a streamable-HTTP
 * JSON-RPC session: an initialize POST, a
 * notifications/initialized POST, then the tools/call
 * POST, carrying the Mcp-Session-Id response header on
 * later requests when the upstream issues one. The
 * session opens lazily on the first forwarded call and
 * is reused for the client's lifetime.
 *
 * Every tool is aggregate sensing over PUBLIC Reddit +
 * Hacker News posts: trending terms by momentum, mention
 * count/velocity/lexical sentiment for a term, top posts
 * with discussion themes, and newly first-appearing
 * terms. The subjects are terms and topics, not
 * identified people.
 *
 * The endpoint is pinned to
 * https://social.dropwatchhq.com/mcp and may be replaced
 * with the SOCIALPULSE_MCP_URL environment variable
 * (that override is a labelled reconstruction). The
 * registry record declares NO headers on the upstream
 * remote, so no auth header is ever sent, under any
 * environment.
 *
 * A successful upstream result is returned exactly as
 * received, isError flag and extra fields included.
 * Failures -- an upstream JSON-RPC error, a non-2xx
 * status, a body that cannot be parsed, or a fetch
 * that throws or times out -- become an isError result
 * whose text begins with `buzzmeter error:` (that
 * rendering is a labelled reconstruction). Replies may
 * be plain JSON or SSE (`data:` lines); the JSON-RPC
 * message whose id matches the request wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://social.dropwatchhq.com/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, verbatim from the live       */
/* capture in harness/fixtures/socialpulse-tools-original.json;        */
/* generated programmatically by parsing and re-serialising the        */
/* fixture JSON, never retyped).                                       */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "trending_topics",
    "description": "What is SURGING on Reddit + Hacker News right now. Returns a ranked list of terms/topics by real-time momentum (recency-weighted engagement across newest posts), scoped to a subreddit or overall. Use to answer 'what's trending on r/<x>' / 'what is the internet talking about today'. Live data from Arctic Shift (Reddit) + HN Algolia — no stale snapshot.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "subreddit": {
          "type": "string",
          "description": "Limit to one subreddit, e.g. 'wallstreetbets' or 'r/SaaS'. Omit for overall (Reddit + HN)."
        },
        "limit": {
          "type": "number",
          "description": "Max trending terms (default 15)."
        }
      }
    }
  },
  {
    "name": "mention_pulse",
    "description": "Mention COUNT + VELOCITY + SENTIMENT for a term, ticker ($AAPL), brand, or product across Reddit + Hacker News over a time window. Returns total mentions, day-by-day buckets, a velocity (rising/falling) signal, lexical sentiment breakdown, and the top posts. Use for brand-watch, ticker-buzz, product-launch tracking, or trend-confirmation. Live data.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "term": {
          "type": "string",
          "description": "The term/ticker/brand/product to track, e.g. 'Claude', '$NVDA', 'Notion'."
        },
        "days": {
          "type": "number",
          "description": "Look-back window in days (default 7, max ~30)."
        },
        "subreddit": {
          "type": "string",
          "description": "Optional: restrict the Reddit side to one subreddit."
        }
      },
      "required": [
        "term"
      ]
    }
  },
  {
    "name": "whats_being_said",
    "description": "Top recent posts and the dominant discussion THEMES for a query across Reddit + Hacker News. Use to quickly understand 'what are people saying about X' — the actual posts plus the co-occurring themes/angles. Each post carries score, comments, sentiment and a link. Live data.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "What to look up, e.g. 'vision pro returns' or 'rust vs go'."
        },
        "days": {
          "type": "number",
          "description": "Look-back window in days (default 14)."
        },
        "subreddit": {
          "type": "string",
          "description": "Optional: restrict the Reddit side to one subreddit."
        },
        "limit": {
          "type": "number",
          "description": "Max posts (default 12)."
        }
      },
      "required": [
        "query"
      ]
    }
  },
  {
    "name": "emerging_terms",
    "description": "Newly FIRST-APPEARING terms from our rolling novelty ledger (Reddit/HN newest posts + the 24/7 idea_intel loop). Surfaces words/phrases/tickers we just started seeing — early-signal detection for new products, memes, projects, or narratives. Each row carries a first_seen date + sample.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "days": {
          "type": "number",
          "description": "Only terms first seen within N days (default 14)."
        },
        "limit": {
          "type": "number",
          "description": "Max terms (default 25)."
        }
      }
    }
  }
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Whether `name` belongs to the captured surface. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `buzzmeter error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Read a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * present, otherwise the last parseable message, otherwise
 * null when nothing in the body parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not a JSON payload; skip this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding a single upstream session,
 * opened lazily on first use and reused from then on
 * (for the process lifetime in the MCP server, or for a
 * single invocation in the CLI).
 */
export class BuzzmeterClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).SOCIALPULSE_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    // The registry record declares NO headers on the upstream
    // remote: no Authorization header is ever sent.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "buzzmeter", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // Nothing needed from the notification response body.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Hand the upstream result back exactly as received.
    return result;
  }
}

/** Build a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): BuzzmeterClient {
  return new BuzzmeterClient(deps);
}

/** One-shot helper: a fresh client for a single call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new BuzzmeterClient(deps).callTool(name, args);
}
