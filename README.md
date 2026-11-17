# buzzmeter

What is surging on Reddit and Hacker News right now, how fast is a term spreading, and what are people actually saying about it? buzzmeter is a local forwarding client for the hosted social-pulse MCP service: it answers `tools/list` locally from the captured tool definitions and forwards every call to the service, returning the answers exactly as the service sends them back.

All four tools are aggregate sensing over public Reddit and Hacker News posts. Their subjects are terms and topics, not identified people: trending terms ranked by momentum, mention counts with velocity and lexical sentiment for a term, top posts with the dominant discussion themes for a query, and terms that have only just started appearing.

## The tools

- **`trending_topics`** — Terms and topics surging on Reddit and Hacker News, ranked by recency-weighted momentum. Optionally scope with `subreddit`; `limit` caps the terms (default 15). No required parameters.
- **`mention_pulse`** — Mention count, velocity and sentiment for a term, ticker, brand or product. `term` is required; `days` sets the look-back window (default 7) and `subreddit` optionally restricts the Reddit side.
- **`whats_being_said`** — Top recent posts and dominant discussion themes for a query. `query` is required; `days` (default 14), `subreddit` and `limit` (default 12) shape the read.
- **`emerging_terms`** — Newly first-appearing terms from a rolling novelty ledger, each with a first-seen date and a sample. `days` (default 14) and `limit` (default 25) shape the read. No required parameters.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/buzzmeter mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "buzzmeter": {
      "command": "npx",
      "args": ["-y", "@reneturcios/buzzmeter", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/buzzmeter
docker run --rm ghcr.io/cloudcorprecords/buzzmeter emerging_terms '{}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
buzzmeter trending_topics '{"subreddit":"wallstreetbets","limit":10}'
buzzmeter mention_pulse '{"term":"$NVDA","days":7}'
buzzmeter whats_being_said '{"query":"rust vs go"}'
buzzmeter emerging_terms '{"days":7,"limit":10}'
buzzmeter --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand or a malformed JSON argument.

## Configuration

- `SOCIALPULSE_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://social.dropwatchhq.com/mcp`. (The override variable is a reconstruction added by this rebuild.)

The upstream registry record declares no headers, so no authentication header is ever sent; the tool surface was captured keyless.

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `buzzmeter error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface (all 4 tools, deep-equal, in order, with no titles invented and no `required` key added to the two tools that carry none), exercises the session handshake and its reuse, verifies that no `Authorization` header is ever sent under any environment, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
