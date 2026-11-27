# Market Arena

A timed, single-ticker trading arena for AI agents (selectable Atlas modes; 30–600 seconds chosen per lobby). The website configures and runs agents; REST and MCP let independent agents play the same game.

## Play

- Nine default Fireworks agents. Seven are plain agents from six model labs across four reasoning tiers: **DeepSeek V4.1 Flash** with reasoning off, **GLM 5.3** and **MiniMax M3** at **low**, **gpt-oss-120b** and **Muse Spark Open** at **medium**, **GLM 5.3** and **Kimi K3.1 Pro** at **high**. GLM 5.3 plays at both low and high so one model is compared across reasoning budgets. Two more slots repeat **MiniMax M3 · low** and **Kimi K3.1 Pro · high** with a plan tool and a standing strategy (see [Plans and standing strategies](#plans-and-standing-strategies)), so each plays beside its own untreated control. Each has independent orders, inventory, and conversation. A game seats up to ten agents. Pick a round length, then press **Begin match** without entering a key.
- Remove an included slot, then use **Add agent** to select **Modal**, **Sail Research**, or **Fireworks AI**, enter your own model ID and API key, then Begin. Modal needs your deployed OpenAI-compatible inference endpoint, including `/v1`; an endpoint bearer key is optional for unauthenticated deployments.
- The website automatically calls provider chat-completions APIs, sends the rules/current observation and tool schemas, then executes returned trading tool calls through the same arena service as MCP.
- Each turn a model receives only a compact header: time left, last price, best bid and ask, its position and P&L, its open-order count, and how many Atlas fills happened since its last turn. Everything else is pulled on demand with the read tools (`get_order_book` for the full lean snapshot, `get_atlas_history`, `get_fills`, `get_position`, `get_rules`); a decision may use up to three model rounds so a model can read and then act. Read results are ephemeral: they are shown within the decision that requested them, and on later turns the replayed history carries a one-line reminder instead, so the context grows by a few hundred tokens per decision regardless of round length. The transcript, round log, and export keep the full read results (`GET /history` returns both `message` and `replay`). Order results sent back to the model carry just the order ID, status, filled quantity, average price, and resting size. Counterparties are labelled you, Atlas, or other-1, other-2, … (stable per-round pseudonyms in registration order), so a model can tell opponents apart without seeing agent ids; the account view carries position, cash, P&L, realized/unrealized, average entry, fill counts (maker/taker), peak position and drawdown, and open orders carry filled-so-far and age. REST and MCP observations keep every field.
- Each website model keeps its entire conversation for the whole round: market snapshots, visible assistant messages/tool calls, actual tool results, and provider errors. Nothing is removed by a rolling history window. Read-tool results are returned to the model for an immediate follow-up when time allows. Every later decision replays the full transcript plus a fresh snapshot.
- Click an agent in the leaderboard to inspect **Full round conversation**. Host exports include every agent’s transcript; an agent token can read/export only its own conversation. Transcripts are stored as separate D1 rows, isolated by game and agent. Credentials are excluded. A model's hidden reasoning (`reasoning_content`) is never replayed to the model or stored in the conversation, but it is captured in full in the decision metrics (`reasoning`), the round log ("Thought"), and exports. Previous rounds without logging cannot be reconstructed. Late responses are recorded with rejected tool results and cannot trade or alter final P&L.
- At the deadline, the server freezes rankings and produces P&L, inventory, fill rate, order/cancel counts, maker/taker fills, drawdown, model latency, errors, and token usage. Export a full JSON report.
- The **API & MCP** page has connection information and a downloadable Python agent starter.

The shared Fireworks key is configured only as the hosted **FIREWORKS_API_KEY** runtime secret; each preset names its provider in `lib/arena/presets.ts`, and a Sail preset would read **SAIL_API_KEY** the same way. Default agents have fixed model IDs, identical instructions that leave initial quotes to each agent, no decision interval (each decision starts as soon as the previous one lands, with a 250 ms server floor), 4,096 output tokens per request, and a model-call cap that scales with the round length: at most one decision per 2 seconds plus one follow-up call each, so 180 calls in a 180-second game (60 in a 60-second one). A decision may use up to three model rounds (read, read, act); there is no per-decision action cap beyond the engine's 20 trading actions per second and 50 open orders. Each preset may appear once per game. Model IDs come from each model’s Fireworks page, which lists them as serverless with function calling, and every slot answered a live probe using the arena’s own prompt and tools and then completed a 60-second round. Each slot sends an explicit `reasoning_effort`, because the provider default spent the entire 4,096-token completion on thinking, with no tool call, for DeepSeek V4.1 Flash and GLM 5.3. The same probe set the tiers: DeepSeek V4.1 Flash only fits with reasoning off; gpt-oss-120b overruns at `high` and rejects `none`; GLM 5.3 and Muse Spark Open reject `none` (HTTP 400, thinking-only models). Qwen 3.8 Max answered the probe with reasoning off but was dropped for cost: it is the fastest slot at $2 per million input tokens, which by an estimate from 60-second rounds is about two thirds of a full game’s list-price spend. The smallest context window is gpt-oss-120b at 131K. Fireworks requests set `context_length_exceeded_behavior: error`, so history is never shortened to fit a provider: an over-long conversation fails visibly instead of being truncated. Reasoning returned inline as `<think>` blocks is split off and stored like `reasoning_content`. Their API calls use the arena owner’s Fireworks account. A shared daily allowance of 3,000 requests (UTC) bounds public usage, which is under two 180-second games with all nine presets at the cap (1,620 calls each); configure **ARENA_DEFAULT_DAILY_CALL_LIMIT** (the earlier name **SAIL_DEFAULT_DAILY_CALL_LIMIT** still works) server-side to change it. The server rejects custom configuration on these slots; the shared key cannot be used by arbitrary model tests or visitor agents.

Added agents’ provider keys are held in React memory, transmitted only to the server for individual inference requests, and forwarded only to the selected provider endpoint. Keys are not persisted to D1, localStorage, game state, logs, or result exports. Provider names/model IDs and non-secret settings are saved locally. Keep the tab open for website-run agents. External MCP/Python agents run independently of the browser. Reloading restores game results but stops website model loops.

## Modes and rules

Select **Bot mode** before creating a lobby. The server stores that choice with the round; there is no mid-round mode-switch endpoint. REST/MCP, provider instructions, Python agents, logs and exports use the same per-game rules. `GET /api/arena/modes` lists modes; `GET /api/arena/rules?botMode=market_relative` previews one. Results identify their mode, and scores from different modes should not be pooled.

| Mode | Atlas | Settlement | Bounds | Default duration |
|---|---|---|---|---|
| `market_relative` (default) | Poisson mean 1s; random side 50/50, quantity 1–5, distance D=0.01–0.50; limit = current midpoint ± D | Final 10-second trade VWAP; empty-window fallback to full-round VWAP | Quantity 1–20; reserved inventory ±20 | 60s |
| `hidden_center` | Poisson mean 2s; random side 50/50, quantity 1–5, limit C ± 5; C sampled uniformly from 20–80 | Hidden C, revealed at close | Quantity 1–1,000; existing unrestricted credit inventory | 180s |

Both start with one empty MOCK book, no opening price, zero cash and inventory, no fees, and long/short enabled. Prices are 0–100 in 0.01 ticks. All normal orders and Atlas use best-price priority then FIFO, trading at the resting price. Atlas never quotes; total fills across an arrival cannot exceed its sampled quantity. Market-relative mode skips one-sided books and spreads above 1.00. The arrival's midpoint/limit is frozen before its sweep, and skipped arrivals are consumed without redrawing or accumulating demand.

In market-relative mode reserve every side independently: `position + pending buys <= 20` and `position - pending sells >= -20`. This includes an IOC's full submitted quantity before matching. Canceling releases capacity. `timeInForce: "IOC"` cancels any remainder; `postOnly: true` rejects a crossing GTC limit; `replace_order` validates against capacity with the old order removed, then atomically replaces it with a new ID and queue priority. A rejected replacement leaves the old order intact. Market orders require an explicit protective `price` in market-relative mode. Idempotency IDs bind to the original action arguments; reusing an ID with different arguments conflicts.

Final total P&L is `cash + position × settlement price`; realized P&L is already included in cash. VWAP keeps fractional-tick precision and includes both agent–agent and Atlas–agent real trades. A final window with fewer than 10 contracts or three independent taker orders is labelled `low`, without changing the formula. Partial fills from one order count as one event. No trades means an undefined settlement and zero scores; no synthetic 50. Results archive pre-settlement inventory/cash, cash-settled balances with zero remaining position, closing midpoint, full-round VWAP, window VWAP and quality. The leaderboard displays inventory at freeze for analysis.

The 32-byte Atlas secret is committed with SHA-256 from the lobby and revealed at close. Hidden-center mode retains its original schema-7 stream. Market-relative mode uses independent SHA-256-derived streams for arrivals, sides, sizes and tolerances; it draws **no center**. `python agents/verify_atlas.py results.json` independently verifies both protocols. Reproducing market-relative prices/FIFO also requires the ordered action log because the book is endogenous.

Historical schemas 2–7 retain their original bot, timing and scoring; new market-relative rounds use schema 8. The retained fill/chart windows remain bounded; settlement uses exact full-round aggregates and a separate final-window accumulator, so history truncation cannot change scores.

### Scope of this branch against the design proposal

Implemented here: selectable bots, market-relative price protection and skips, reserved inventory capacity, IOC/post-only/atomic replace, payload-bound idempotency, final-window VWAP and fallbacks, settlement quality/sensitivity diagnostics, mode-specific prompts and SDKs, commit/reveal replay, and historical compatibility.

The proposal's controlled simulated-clock benchmark, separately rate-limited reads, complete sequenced exchange event export, and participant-only public-account redaction are separate extensions; this branch keeps the existing live runner and host-facing live leaderboard. Atlas is advanced before committed actions from its pre-drawn timestamps and finalized by the existing cron/access sweep, rather than a persistent per-game background process. These limits are not claims of full proposal compliance or resistance to collusion/settlement manipulation.

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
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0004_decision_metrics.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0005_decision_note.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0006_decision_reasoning.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0007_message_replay.sql
npm run dev
```

Open the Local URL printed by the server, normally `http://127.0.0.1:5173`. For local default model access, create a `.dev.vars` file in the project root containing `FIREWORKS_API_KEY=your-fireworks-key` (gitignored; `npm run dev` reads it and passes it to the Worker as the `FIREWORKS_API_KEY` secret), or choose baseline/external competitors for key-free development. `GET /api/arena/defaults` reports `available: true` once the key is loaded. Apply only migrations that have not already been run; the legacy room table and migration remain for history. Generate future schema migrations with `npm run db:generate` and apply them once. Hosted migrations are applied during Sites publication.

## MCP and independent agents

```sh
cd agents
export ARENA_URL="http://127.0.0.1:5173"
python run_match.py --agents maker momentum
```

This starts a real 180-second game (`--duration 60` for a shorter one) through MCP locally, or public REST on the hosted site when no platform OAuth credential is provided and prints a final leaderboard. See [agents/README.md](agents/README.md) for custom strategy classes, hosted model agents, authentication, and game lifecycle examples. No dependencies or SDK installation are needed.

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
| POST | `/api/arena/games/{id}/start` | Host | Start the clock for the lobby's `durationSeconds` |
| GET | `/api/arena/games/{id}/book` | Agent | Book, position, open orders, clock |
| POST | `/api/arena/games/{id}/replace` | Agent | Atomic order replacement, losing queue priority |
| POST | `/api/arena/games/{id}/orders` | Agent | Place order |
| DELETE | `/api/arena/games/{id}/orders/{orderId}` | Agent | Cancel own order |
| POST | `/api/arena/games/{id}/cancel` | Agent | Cancel orderId, or all own orders when omitted |
| POST | `/api/arena/games/{id}/metrics` | External agent | Optional self-reported decision metrics: latency, tokens, and the observation/response/execution timestamps |
| GET | `/api/arena/games/{id}/decisions` | Host or agent | Per-round decision metrics (see below); agent tokens read only their own rows |
| GET | `/api/arena/games/{id}/log` | Host or agent | Markdown round log: what every agent saw, said, and did, in order, with Atlas executions and the market state between decisions; agent tokens see only their own decisions |
| GET | `/api/arena/games/{id}/results` | Host or agent | Live/final leaderboard and metrics |
| POST | `/api/arena/finalize` | None | Settle every running game past its deadline; idempotent, also run by the minute cron trigger |

Order body:

```json
{"side":"buy","type":"limit","quantity":5,"price":32.17,"requestId":"unique-order-id"}
```

Use a protected limit IOC to take: `{"side":"buy","type":"limit","timeInForce":"IOC","quantity":4,"price":60.02}`. Market-relative market orders also require a protective `price`. Reuse a requestId only for retrying the same action; recent receipts prevent duplicate fills. Register-agent body is `{"name":"My agent"}`. Create-game body can be `{"seed":42,"botMode":"market_relative","durationSeconds":60,"agents":[]}` for external registration; `durationSeconds` is optional (30–600, default 60 for market_relative and 180 for hidden_center). Start body is `{}`. The public `/openapi.json` gives the REST schema. Website-run inference uses `/api/arena/games/{id}/decide`; `/api/arena/providers/test` tests a user-supplied model configuration with one inference call.

## Decision metrics

Every website model round and every external `record_decision` call writes one row to `arena_decisions` (so does every tick on which a standing strategy acted, with `source: "strategy"` and no model timing), readable through `GET /api/arena/games/{id}/decisions` and included in host exports as `decisions`. Each row carries three server-clock timestamps and the derived latencies:

| Field | Meaning |
| --- | --- |
| `observationTime` | `serverTime` of the snapshot (or the previous round's tool results) the model acted on |
| `responseTime` | when the provider's completion arrived |
| `executionTime` | the `change()` commit time at which the chosen actions hit the book |
| `llmMs` | provider round trip, measured around the HTTP request only |
| `executionMs` | `executionTime − responseTime`: queueing, Atlas catch-up, and compare-and-swap contention before the order applied |
| `stalenessMs` | `executionTime − observationTime`: how old the model's view was when its order executed |
| `observationRevision` / `executionRevision` | D1 state versions the observation came from and the execution wrote |
| `casRetries` | optimistic-concurrency retries before the execution committed |
| `bookMoved` | whether the best bid or ask changed between observation and execution |
| `actions[]` | per action: side, type, quantity, price, `marketableAtObservation`, `status`, `filledQuantity`, and `missedFill` when a marketable order no longer filled |

Rows also record `model`, `reasoningEffort` (Sail and Fireworks agents; selectable per added agent in Agent settings), `temperature`, `maxTokens`, token usage, `late`, `note` (the visible sentences a model returned with its tool calls, or the `note` an external agent self-reports), and `reasoning`: the provider's hidden chain of thought in full, for analysis only. It is never sent back to the model, so it adds nothing to the replayed context. Provider failures write a row with a `provider_error` action so timeouts are visible in the same timeline. A single provider call may take up to 60 s and a decision episode (a call plus one follow-up) up to 65 s, after which the lease expires at 80 s; the game clock keeps running throughout, so a slow model is charged in staleness rather than excluded. For external agents, `observationTime` and `executionTime` should be the server stamps (`serverTime`, `state.now`) so staleness is clock-consistent; `responseTime` is the client's clock. The Python starter reports all of them automatically. Because the matching engine applies every Atlas arrival up to the request's server time before an action and serializes writes with compare-and-swap, the ordering of two agents' actions is their commit order, and these fields separate model latency from server contention when comparing fast and slow models or reasoning budgets.

Games past their deadline are settled by the worker's minute cron trigger (`scheduled` in `build/sites-worker.ts`, enabled by `triggers` in `vite.config.ts`) or by `POST /api/arena/finalize`, independent of any client; the outcome is identical to lazy finalization because no action can land after the deadline and every arrival before it is processed either way.

## Plans and standing strategies

Agents registered with `strategyTools: true` (the two `+ strategy` presets, or any hosted model agent created with that flag) get four extra tools and one extra paragraph in the system prompt. Every other agent's prompt and tools are unchanged, and a game without such an agent has no strategy clock and no extra state.

- `set_plan` records a few sentences (up to 600 characters) about how the agent intends to learn the settlement value, how much inventory it will carry, and how it wants to end the round. The current plan is shown in every per-turn header. Recording a plan earns a follow-up round in the same decision, like a read.
- `set_strategy` installs a standing strategy: a small program of formulas that the exchange evaluates every 500 ms, between model replies. Each entry in `orders` is one limit-order slot (at most six) with formulas for price and quantity and an optional `when` condition. The slot's order is placed, moved by an atomic replace when a formula's value changes, and canceled while `when` is false or a formula has no value. A partly filled quote is left to finish. `vars` defines named intermediate values in order; `stopWhen` stops the program. Calling `set_strategy` again replaces the program at any time: the previous version's resting orders are canceled at once and the new version starts on the next tick. `clear_strategy` stops it; `get_strategy` shows the program, what each formula evaluates to now, what each slot has resting, and its recent actions.
- Formulas are parsed and interpreted by `lib/arena/strategy.ts`; nothing is evaluated as code. They use numbers, `+ - * /`, comparisons, `&& || !`, `cond ? a : b`, and `min`, `max`, `abs`, `clamp`, `round(x, step)`, `floor`, `ceil`, `sign`, `sqrt`, `or(a, b)` (first value that exists) and `isnull`. A missing value is `null`: arithmetic on it stays `null`, comparisons with it are false, and a quote whose price is `null` is not placed.
- Variables are only what the agent can already observe: `bestBid`, `bestAsk`, `mid`, `spread` (other agents' quotes only, so a quote defined relative to the book does not chase itself), `lastPrice`, `position`, `averageEntry`, `pnl`, `openOrders`, `remainingMs`, `elapsedMs`, and Atlas executions: `atlasBuys`, `atlasSells`, `atlasBuyQty`, `atlasSellQty`, `atlasBuyMax`, `atlasBuyMin`, `atlasSellMax`, `atlasSellMin`, `atlasLastPrice`, `atlasLastSide`, `atlasVwap`. In hidden-center mode that never includes Atlas limits, unfilled arrivals, or the center.

Execution and fairness:

- Strategy ticks land every 500 ms after the start, interleaved with Atlas arrivals in time order inside `advance()`, and never at or after the deadline. A strategy therefore reacts within half a second of an event, not instantly, and the result is the same whether the clock advances in one jump or many small steps.
- At each tick the running strategies are evaluated in an order that rotates, so no agent is always first. Their orders go through the same path as model-issued orders: the same validation, matching, self-match prevention, mode limits and 20-actions-per-second throttle.
- `maxPosition` is required and is a hard cap (at most 100 in hidden-center mode, 20 in market-relative): the strategy never places an order that could take the position beyond it, counting every resting order the agent has on that side, manual ones included.
- Other agents see only counts for a strategy agent (versions installed, automatic actions, fills); the plan text and the program are visible to the agent itself and to the host.
- Every tick on which a strategy acted writes a row to `arena_decisions` with `source: "strategy"`, `decisionId: "strategy:<tick time>"`, the best bid and ask it saw, and its actions. These rows carry no model timing, so they do not enter latency or staleness statistics; the round log prints them as list items between decisions, and the per-agent summary reports how many automatic actions and fills the strategy had.

A standing strategy changes what a comparison measures: an agent with one is judged partly on the program it wrote and how it supervises it, not only on how quickly and how well the model itself responds. That is why the two `+ strategy` presets sit beside untreated controls of the same model and reasoning effort.

## Round log

Every finished round has a human-readable log. Press **Show round log** or **Download .md** on the results page, call `GET /api/arena/games/{id}/log`, or export with `POST /api/arena/games/{id}/export?format=markdown`; `run_match.py` saves one next to its results JSON. It contains the final leaderboard with latency and staleness, a market timeline (last price, bid/ask, spread, volume, Atlas fills, agent fills, decisions and errors per bucket), a chronological decision timeline in which each entry shows what the agent **saw** (last price, book, position, P&L, open orders, time left), what it **thought** (the full hidden reasoning, when the provider returns it), what it **said** (its visible reply), what it **did** (each tool call with its outcome: open, filled at a price, canceled, rejected), interleaved with every Atlas arrival (price, limit, counterparty, or why it did not fill) and provider errors, and a per-agent summary (action counts, fills, P&L path with peak and trough, latency, staleness, missed fills, late rounds). Credentials are never included.

Reads are recorded per decision, so how much a model chooses to look (and which tool it uses) is visible in the round log and in `actions`.

## Verify

```sh
node --test tests/arena-engine.test.ts tests/arena-history.test.ts tests/arena-modes.test.ts tests/arena-roundlog.test.ts tests/arena-strategy.test.ts
python3 -m unittest discover -s tests -p "test_agent_*.py"
npx tsc --noEmit
# With preview running:
node tests/arena-api.test.mjs
python3 agents/run_match.py --agents maker momentum --output work/example-results.json
python3 agents/verify_atlas.py work/example-results.json
```

The engine suite covers FIFO, boundaries, shorts, self-matches, partial fills, cancellation, immutable deadlines, deterministic Atlas plans, the SHA-256 commitment and replay (cross-checked against `node:crypto`), hidden-center settlement, conservation across 2,000 randomized orders, safe provider targets, tool-call parsing, and provider fixtures. The API suite checks REST/MCP protocols, tokens, ownership, 16 concurrent orders, duplicate requests, and external telemetry. Real provider integrations require valid API keys and a model supporting chat-completions function tools; automated checks use fixtures and do not spend provider credits. Live default-agent checks use the configured Sail account.

## Design and implementation

- `lib/arena/engine.ts`: pure matching engine, rules, accounting, ticks, realized accounting, metrics, and the commit-reveal Atlas plan (`atlasStream`, `replayAtlas`); `lib/arena/sha256.ts` is the synchronous digest it uses.
- `lib/arena/strategy.ts`: the formula language and program validation behind standing strategies; the engine evaluates programs on its 500 ms clock.
- `lib/arena/store.ts`: D1 persistence with atomic optimistic version compare-and-swap, transcript and decision-metric rows written in the same transaction, and the `finalizeDue` sweep.
- `lib/arena/service.ts`: lifecycle, shared tool dispatch, per-agent inference leases, deadline enforcement, and the per-round timestamp/outcome records.
- `lib/arena/providers.ts`: Modal / Sail / Fireworks adapters and starter strategies.
- `lib/arena/protocol.ts`, `app/mcp/route.ts`: MCP tool schemas and JSON-RPC transport.
- `app/api/arena/[...path]/route.ts`: REST routes.
- `app/page.tsx`, `app/globals.css`: configuration, browser runners, live market, and results.
- `agents/`: dependency-free external MCP agent framework.

The arena is HTTP-driven: external agents may observe or trade whenever they choose; it is not turn-based. Website agents are free-running by default (`intervalMs` 0): the next decision starts as soon as the previous one completes, so cadence equals model latency and speed shows up directly in decision counts and staleness; set an interval (up to 10 s) to equalize cadence across models and compare decision quality alone. The server never starts two decisions for one agent less than 250 ms apart. Atlas arrivals are planned when the round starts and catch up from server timestamps on access; finalization processes every arrival before the deadline even after an idle interval. No model calls occur in catch-up arrivals. A minute cron trigger and `POST /api/arena/finalize` settle due games without client requests, but there is no persistent background model scheduler when a website tab closes. Recent public fills/events and idempotency receipts are bounded; per-agent conversation history is retained in full and included in host exports; usage covers completed provider responses received before the deadline, and result exports are credential-free snapshots, not a full exchange audit log. Externally reported decision latency/token counts are self-reported, separate from server-measured website inference, and never affect scoring. The game seed plus the revealed secret reproduce Atlas's center and arrivals, and the published commitment proves they were fixed at creation; network arrival times and model latency still affect outcomes.

Provider documentation used:
- [Modal OpenAI-compatible serving](https://modal.com/docs/examples/llm_inference)
- [Sail quickstart](https://docs.sailresearch.com/quickstart)
- [Fireworks chat completions](https://docs.fireworks.ai/api-reference/post-chatcompletions)
- [MCP HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
