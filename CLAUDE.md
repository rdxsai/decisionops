# CLAUDE.md — DecisionOps Agent

Guidance for AI agents working in this repo. Read `UPDATE.md` for the current-state handoff (what's done / what's next). Read `docs/superpowers/specs/2026-06-28-decisionops-design.md` for the full design rationale and `docs/superpowers/plans/2026-06-28-decisionops-v1.md` for the task-by-task build.

## What this is
DecisionOps is a Slack agent (Slack Agent Builder Challenge entry) invoked by a **message shortcut ("Capture decision")**. It turns a thread into a context-grounded **decision brief in a Canvas**, routes a **Block Kit approval**, posts the final decision with owners, and **remembers** it so the next decision in that area is cheaper to build.

The differentiated bet is **incremental, Slack-native memory**: the entity's *static* profile rides in a prompt-cached system block, the *dynamic* profile is injected per turn, and retrieval is a **bounded (≤6-call), delta-scoped** Real-Time Search — so warm captures search far less than cold ones.

**v1 is validated live** against real Slack + Anthropic (see `UPDATE.md`).

## Commands
```bash
npm install
npm test                    # Vitest — full suite (44 tests). Run this before every commit.
npm run build               # tsc -p tsconfig.json
npx tsc -p tsconfig.json --noEmit   # typecheck only (app.ts is not unit-tested — this is its gate)
npm run doctor              # preflight: pings Slack bot/user auth, Ledger channel, RTS, Anthropic (needs .env)
npm run seed -- <CHANNEL_ID>  # post decision threads into a channel (fresh-workspace helper; bot must be a member)
npm run dev                 # run the agent (Socket Mode). Reads .env via dotenv.
```
`.env` (copy from `.env.example`): `SLACK_BOT_TOKEN` (xoxb), `SLACK_APP_TOKEN` (xapp), `SLACK_SIGNING_SECRET`, `SLACK_WORKSPACE_TOKEN` (xoxp — RTS searches AS this user), `LEDGER_CHANNEL_ID` (C…), `ANTHROPIC_API_KEY`. See `SETUP.md` for the Slack app setup walkthrough + `slack-app-manifest.yaml`.

## Architecture — two loops, one Slack-native store
- **Capture loop (foreground, user waits)** — `src/agent/capture.ts`: hydrate thread → resolve the decision → recall the entity profile from the Ledger (cold-start inline if none) → bounded RTS gap-search → synthesize the brief. Returns materials; posts nothing.
- **Observer (inline, on finalize)** — `src/memory/observer.ts`: folds the approved decision + delta into the entity's static/dynamic profile and advances the delta cursor.
- **Ledger (the ONLY datastore)** — `src/slack/ledger.ts`: `decision_record` + `entity_profile` objects stored as **Slack message metadata** in one private channel; read back via `conversations.history?include_all_metadata=true`, append-only, latest-wins. No DB/vector store/files for state.
- **Own-the-loop LLM** — `src/agent/llm.ts`: thin wrapper over the **Anthropic Messages API** (not the Claude Agent SDK). `cachedSystem()` (static profile in the cached system block), `dynamicSystemMessage()` (dynamic profile as a mid-conversation `role:"system"` message), `structured()` (json_schema), `toolLoop()` (bounded manual agentic loop).

## Module map
| File | Responsibility |
|---|---|
| `src/types.ts` | Domain types + `event_type` constants. Single source of truth — imported everywhere. |
| `src/slack/ledger.ts` | Read/write decision_record + entity_profile via message metadata. |
| `src/slack/thread.ts` | `conversations.replies` → flattened `@user: text`. |
| `src/slack/canvas.ts` | Render the brief markdown (audience-scoped) + create/update the Canvas. |
| `src/slack/blocks.ts` | Block Kit approval card + final-decision blocks. |
| `src/rts/search.ts` | `assistant.search.context` wrapper — keyword-first, `results.messages` parsing, provenance ContextRefs. |
| `src/rts/budget.ts` | Hard ≤6-call budget guard. |
| `src/agent/resolve.ts` | Thread → decision statement/options/entities/open-questions (structured). |
| `src/agent/gapcheck.ts` | Bounded RTS tool loop, delta-scoped by the profile cursor. |
| `src/agent/synthesize.ts` | Thread + refs → Brief (structured). |
| `src/agent/capture.ts` | Orchestrates the foreground pipeline. |
| `src/memory/observer.ts` | `coldProfile` + `consolidate` (code is authoritative for cursor/refreshedAt). |
| `src/permissions/scope.ts` | Provenance-not-payload + audience gating (no "laundering"). |
| `src/agent/llm.ts` | Anthropic runtime (see above). |
| `src/config.ts` | Env loading + validation. |
| `src/app.ts` | Bolt wiring: shortcut → capture → canvas → approval → finalize → observer. **Not unit-tested — its gate is `tsc --noEmit` + a live run.** |
| `src/doctor.ts` / `src/seed.ts` | Ops tooling (preflight / workspace seeding). |

## Conventions
- **ESM + strict TS.** Intra-repo imports use the `.js` extension (`../types.js`) even from `.ts` files (`moduleResolution: Bundler`). Test files omit `.js` (Vitest resolves them).
- **TDD, Vitest.** Every module has a `test/**` mirror. Tests use **dependency injection** — modules take their Slack/Anthropic clients as parameters so tests fake them. **When you change what a real API returns, update the mock to match reality** (see the RTS-shape fix in `UPDATE.md`).
- **Model:** `claude-opus-4-8`. `src/agent/llm.ts` `BASE` is **cost-tuned**: no adaptive thinking, `effort: "low"`, `max_tokens: 4096`. Do not add expensive knobs back without reason.

## Gotchas / hard constraints (don't relearn these the hard way)
- **RTS `assistant.search.context` returns `results` as an OBJECT** `{messages,files,channels,users}`, not an array. Read `results.messages`.
- **RTS must use the user/workspace token** (`SLACK_WORKSPACE_TOKEN`), not the bot token — it searches *as the user*. Org/Grid tokens return `enterprise_is_restricted`.
- **Semantic search is off on Pro/keyword-only plans** — the agent is keyword-first by design; `doctor` reports `semantic_search_enabled=false`, which is expected.
- **Mid-conversation `role:"system"` messages are Opus-4.8-ONLY.** `dynamicSystemMessage()` uses this. If you switch models (e.g. Haiku for cost), you MUST fold the dynamic profile into the user turn instead, or it 400s. Also: such a message can never be `messages[0]` — it must follow a user message.
- **Prompt cache is a prefix match.** Static profile is bundled with instructions under one `cache_control` breakpoint (below 4096 tokens it won't cache — that's why they're bundled).
- **Canvas is write-only** via the Web API (no read-back). State lives in metadata; the Canvas is rendered from it.
- **Keep the app internal/custom** — distributed non-Marketplace apps get the 2025 `conversations.history` throttle (1/min × 15).
- **Provenance, not payload:** the Ledger/brief store permalinks + short snippets and link to sources; a private snippet must never inline into a broader-audience brief (`scope.ts`).
- **Cost:** every live capture spends real Opus tokens. The cold-vs-warm proof is the free `eval/harness.test.ts` — prefer it over live runs when demonstrating the memory win.

## Out of scope (phase 2 — each needs its own design→plan→build)
Async/event-driven observer, proactive "this looks like a decision" nudge, slash-command + assistant-container surfaces, seeded real-workspace retrieval-quality eval, Marketplace submission. See `UPDATE.md` for the ranked next steps + a known entity-keying refinement.
