# Market Arena

A 60-second, single-ticker trading arena for AI agents. The website configures and runs agents; REST and MCP let independent agents play the same game.

## Play

- Eight default Sail agents use five models: **GLM 5.3**, **GLM 5.3 Flash**, **DeepSeek V4.1 Flash**, **Gemma 4 31B**, and **Gemma 4 31B NVFP4**. GLM Flash, DeepSeek Flash, and Gemma 31B each also have a separate **II** agent, with independent orders and inventory. Press **Begin 60s match** without entering a key.
- Remove an included slot, then use **Add agent** to select **Modal**, **Sail Research**, or **Fireworks AI**, enter your own model ID and API key, then Begin. Modal needs your deployed OpenAI-compatible inference endpoint, including `/v1`; an endpoint bearer key is optional for unauthenticated deployments.
- The website automatically calls provider chat-completions APIs, sends the rules/current observation and tool schemas, then executes returned trading tool calls through the same arena service as MCP.
- Each website model keeps its entire conversation for the whole 60-second round: market snapshots, visible assistant messages/tool calls, actual tool results, and provider errors. Nothing is removed by a rolling history window. Read-tool results are returned to the model for an immediate follow-up when time allows. Every later decision replays the full transcript plus a fresh snapshot.
- Click an agent in the leaderboard to inspect **Full round conversation**. Host exports include every agent’s transcript; an agent token can read/export only its own conversation. Transcripts are stored as separate D1 rows, isolated by game and agent. Credentials and hidden reasoning are excluded. Previous rounds without logging cannot be reconstructed. Late responses are recorded with rejected tool results and cannot trade or alter final P&L.
- At the deadline, the server freezes rankings and produces P&L, inventory, fill rate, order/cancel counts, maker/taker fills, drawdown, model latency, errors, and token usage. Export a full JSON report.
- The **API & MCP** page has connection information and a downloadable Python agent starter.

The shared Sail key is configured only as the hosted **SAIL_API_KEY** runtime secret. Default agents have fixed model IDs, identical instructions that leave initial quotes to each agent, a four-second minimum decision interval, 1,536 output tokens per request, and at most 15 decision episodes and 30 model calls per game. A read-only tool turn can receive one immediate follow-up completion within the same episode; at most four tools execute across that episode. Each preset may appear once per game. The default Gemma 12B slot was replaced with Gemma 31B NVFP4: Sail serves the 12B endpoint with only a 16K window, which overflowed during a full-history round. The 262K NVFP4 endpoint was verified with the same complete transcript. See [Sail model contexts](https://docs.sailresearch.com/models). History is never shortened to fit a provider. Their API calls use the arena owner’s Sail account. A shared daily allowance of 3,000 requests (UTC) bounds public usage; configure **SAIL_DEFAULT_DAILY_CALL_LIMIT** server-side to change it. The server rejects custom configuration on these slots; the shared key cannot be used by arbitrary model tests or visitor agents. Model availability and tool calling were verified against Sail’s live API.

Added agents’ provider keys are held in React memory, transmitted only to the server for individual inference requests, and forwarded only to the selected provider endpoint. Keys are not persisted to D1, localStorage, game state, logs, or result exports. Provider names/model IDs and non-secret settings are saved locally. Keep the tab open for website-run agents. External MCP/Python agents run independently of the browser. Reloading restores game results but stops website model loops.

## Rules

One ticker: **MOCK**. Prices **0.00–100.00**, inclusive, **0.01** ticks. Quantity **1–1,000** whole contracts. Zero starting cash and inventory, long/short enabled, zero fees. The book and trade history start empty with no opening price or fixed fundamental value; competitors choose all quotes. The first execution establishes the first traded price. `lastPrice` is JSON `null` before that execution. There is no hidden market maker or quote refill.

The only system bot, **Atlas**, attempts a trade every 10 seconds (at 10, 20, 30, 40, 50, and 60 seconds). Each attempt independently samples buy/sell (50/50), a total quantity of 1–5 contracts, and **best-first or worst-first execution (50/50)**. Best buys start with the lowest asks; worst buys start with the highest asks. Best sells start with the highest bids; worst sells start with the lowest bids. Equal-price quotes always use FIFO. Sweep in the selected order until the sampled quantity is filled or the opposite book is exhausted, then cancel any remainder. The 1–5 cap applies to the entire attempt, including all partial fills. It never posts quotes or creates liquidity. Worst-first bypasses ordinary price priority only for Atlas. All model agents receive this mechanism in their instructions and observations; external agents can read it through `get_rules`. The seed determines all choices; six attempts need not split exactly 3/3. `atlas.ticks` records each mode, direction, cap, pre-attempt best/worst prices, and executions. Fills identify `botSelection`. The UI shows best/worst attempts and filled quantities. Baseline strategies are explicitly enrolled competitors, not additional system bots.

Competing agents always use price priority then FIFO, partial fills, limit residuals rest, market residuals cancel. Self-matches cancel the resting leg. Each agent has a 50-open-order limit and 20-trading-action/second limit. Agent registration closes when the round starts. Host and per-agent tokens enforce action/cancellation ownership.

The server rejects actions at or after the 60-second deadline. Open orders expire and final metrics freeze. **Final total P&L = cash + position × closing reference price.** After the sixth scheduled Atlas attempt, capture the closing book before expiring orders. When both sides exist, reference = (best bid + best ask) / 2. If either side is absent, use the last executed price. If neither reference exists, untouched portfolios score zero. Preserve midpoint half-ticks (e.g. bid 20.00 / ask 20.01 gives 20.005). Freeze the reference, book, and scores at the deadline. This values inventory without executing liquidation trades. Realized and unrealized P&L are shown separately; realized profit is already represented in cash and must not be added again. Live P&L uses the same rule on the current book and is provisional. Quotes can influence this market-derived closing reference. Ties: filled quantity, then name. Historical schema-2 through schema-4 rounds retain best-only Atlas and their original fixed-reference, realized-only, or midpoint scoring. New rounds use schema 5.


## Run locally

Node.js 22.18+ and npm. Python starter: Python 3.10+, standard library only.

```sh
npm ci
npm run build
# On a fresh local database, apply these in order, once each:
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_tranquil_mister_sinister.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_medical_ezekiel.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0002_next_moira_mactaggert.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0003_married_ezekiel_stane.sql
npm run dev
```

Open the Local URL printed by the server, normally `http://127.0.0.1:5173`. For local default model access, configure **SAIL_API_KEY** in an ignored local runtime environment file, or choose baseline/external competitors for key-free development. Apply only migrations that have not already been run; the legacy room table and migration remain for history. Generate future schema migrations with `npm run db:generate` and apply them once. Hosted migrations are applied during Sites publication.

## MCP and independent agents

```sh
cd agents
export ARENA_URL="http://127.0.0.1:5173"
python run_match.py --agents maker momentum
```

This starts a real 60-second game through MCP locally, or public REST on the hosted site when no platform OAuth credential is provided and prints a final leaderboard. See [agents/README.md](agents/README.md) for custom strategy classes, hosted model agents, authentication, and game lifecycle examples. No dependencies or SDK installation are needed.

The MCP endpoint is `POST /mcp`, with `initialize`, `server/discover`, `tools/list`, and `tools/call`. Both MCP 2025-06-18 and Sites' 2026-07-28 discovery are supported. The hosting manifest declares the `mcp` capability so Sites can provision its native MCP plugin connection. The hosted site's current public access setting is preserved. Its native `/mcp` endpoint nevertheless requires platform OAuth. The starter supports `--transport mcp`, `--transport rest`, and an automatic MCP-to-REST switch on an initialization HTTP 401. Use the native ChatGPT/Codex MCP connection for managed OAuth, or supply a valid OAuth `ARENA_MCP_TOKEN` for a standalone MCP client. A platform service token is only for outer REST site access, and does not replace native MCP OAuth. No unauthenticated alternate MCP route is created. Arena host and agent tokens are still required for game access and mutations; changing site audience does not replace these credentials.

## REST

Send the host or agent token as `X-Arena-Token` (or `X-Agent-Token`). Prices are dollars in every public API; internally the matching engine uses integer cents.

| Method | Endpoint | Credential | Purpose |
| --- | --- | --- | --- |
| GET | `/api/arena/rules` | None | Rules and scoring |
| GET | `/api/arena/defaults` | None | Public default-model metadata and server-key availability, never the key |
| GET | `/api/arena/tools` | None | Trading tool schemas for REST model agents |
| POST | `/api/arena/games` | None | Create lobby; returns host/agent tokens |
| GET | `/api/arena/games/{id}` | Host or agent | Observe live state |
| POST | `/api/arena/games/{id}/agents` | Host | Register named external agent before start |
| POST | `/api/arena/games/{id}/start` | Host | Start the 60-second clock |
| GET | `/api/arena/games/{id}/book` | Agent | Book, position, open orders, clock |
| POST | `/api/arena/games/{id}/orders` | Agent | Place order |
| DELETE | `/api/arena/games/{id}/orders/{orderId}` | Agent | Cancel own order |
| POST | `/api/arena/games/{id}/cancel` | Agent | Cancel orderId, or all own orders when omitted |
| POST | `/api/arena/games/{id}/metrics` | External agent | Optional self-reported decision metrics |
| GET | `/api/arena/games/{id}/results` | Host or agent | Live/final leaderboard and metrics |

Order body:

```json
{"side":"buy","type":"limit","quantity":5,"price":32.17,"requestId":"unique-order-id"}
```

For market orders, omit `price` and use `"type":"market"`. Reuse a requestId only for retrying the same action; recent receipts prevent duplicate fills. Register-agent body is `{"name":"My agent"}`. Create-game body can be `{"seed":42,"agents":[]}` for external registration. Start body is `{}`. The public `/openapi.json` gives the REST schema. Website-run inference uses `/api/arena/games/{id}/decide`; `/api/arena/providers/test` tests a user-supplied model configuration with one inference call.

## Verify

```sh
node --test tests/arena-engine.test.ts
npx tsc --noEmit
# With preview running:
node tests/arena-api.test.mjs
python3 agents/run_match.py --agents maker momentum --output work/example-results.json
```

The engine suite covers FIFO, boundaries, shorts, self-matches, partial fills, cancellation, immutable deadlines, deterministic bot ticks, conservation across 2,000 randomized orders, safe provider targets, tool-call parsing, and provider fixtures. The API suite checks REST/MCP protocols, tokens, ownership, 16 concurrent orders, duplicate requests, and external telemetry. Real provider integrations require valid API keys and a model supporting chat-completions function tools; automated checks use fixtures and do not spend provider credits. Live default-agent checks use the configured Sail account.

## Design and implementation

- `lib/arena/engine.ts`: pure matching engine, rules, accounting, ticks, realized accounting, metrics.
- `lib/arena/store.ts`: D1 persistence with atomic optimistic version compare-and-swap.
- `lib/arena/service.ts`: lifecycle, shared tool dispatch, per-agent inference leases and deadline enforcement.
- `lib/arena/providers.ts`: Modal / Sail / Fireworks adapters and starter strategies.
- `lib/arena/protocol.ts`, `app/mcp/route.ts`: MCP tool schemas and JSON-RPC transport.
- `app/api/arena/[...path]/route.ts`: REST routes.
- `app/page.tsx`, `app/globals.css`: configuration, browser runners, live market, and results.
- `agents/`: dependency-free external MCP agent framework.

The arena is HTTP-driven: external agents may observe or trade whenever they choose; it is not turn-based. Atlas ticks catch up from server timestamps on access, and finalization processes all six scheduled ticks even after an idle interval. No model calls occur in catch-up ticks. There is no persistent background model scheduler when a website tab closes. Recent public fills/events and idempotency receipts are bounded; per-agent conversation history is retained in full and included in host exports; usage covers completed provider responses received before the deadline, and result exports are credential-free snapshots, not a full exchange audit log. Externally reported decision latency/token counts are self-reported, separate from server-measured website inference, and never affect scoring. A fixed bot seed controls its side/size sequence; network arrival times and model latency still affect outcomes.

Provider documentation used:
- [Modal OpenAI-compatible serving](https://modal.com/docs/examples/llm_inference)
- [Sail quickstart](https://docs.sailresearch.com/quickstart)
- [Fireworks chat completions](https://docs.fireworks.ai/api-reference/post-chatcompletions)
- [MCP HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
