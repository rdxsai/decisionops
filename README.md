# DecisionOps

**A Slack-native AI agent that turns a discussion thread into a captured, approved, and _remembered_ decision.**

Built for the Slack Agent Builder Challenge. A human invokes it on a message ("Capture decision"); it gathers just-enough context, drafts a decision brief in a Canvas, routes approval with buttons, posts the final decision with follow-up owners, and **remembers** what it learned so the next decision in that area is cheaper and richer to build.

---

## The wedge

Decisions get made in Slack and then evaporate — three months later nobody can reconstruct *why*. DecisionOps' differentiated bet is **incremental, Slack-native memory**: it doesn't rebuild context from scratch every time. It searches extensively once per area, consolidates that into reusable per-entity profiles, and afterward only searches the **delta**.

Concretely, the memory rides the LLM's own machinery:
- the entity's **static profile** sits in a **prompt-cached system block**,
- the **dynamic profile** is injected per turn as a mid-conversation system message,
- retrieval is a **bounded (≤6-call), delta-scoped** Real-Time Search.

So **warm captures search far less than cold ones** — the win is proven for free in `eval/harness.test.ts` (`cold=3, warm=0`).

## Architecture — two loops, one Slack-native store

```
╔══════════════════════ SLACK-NATIVE STATE (the Ledger) ═══════════════════════╗
║  One private channel. Each message carries JSON in its metadata:              ║
║    • decision_record        (one per captured decision)                       ║
║    • entity_profile         (one per channel/project: static + dynamic)       ║
║    • channel_registration   (observer opt-in, reconciled from bot membership) ║
║  Read back via conversations.history?include_all_metadata=true. No DB.        ║
╚════════▲═══════════════════════════════════════════════════════▲═════════════╝
         │ read (free) / write records + profiles                 │
   CAPTURE LOOP — foreground (user waits)         OBSERVER — inline + async (off the hot path)
   hydrate → resolve → recall profile →           folds approved decisions and ongoing channel
   bounded RTS gap-search → synthesize →           activity into the entity profile; advances the
   Canvas brief → Block Kit approval → finalize    delta cursor so the next capture starts warm
```

- **Slack is the entire backend.** No external database, vector store, or object store — all state is Slack message metadata. Compute is a self-hosted Bolt app.
- **Own-the-loop LLM.** The agent loop is driven directly via the **Anthropic Messages API** (`@anthropic-ai/sdk`, model `claude-opus-4-8`), not the higher-level Agent SDK — because harness-level memory means placing exactly the right bytes in context each turn, and retrieval is deliberately *bounded*, not open-ended.
- **Permission discipline.** RTS runs **as the invoking user** (a workspace token) and returns only what that user can see. The Ledger and briefs store **provenance, not payload** (permalinks + short snippets), and content is audience-scoped so a private snippet can't leak into a broader-audience brief.

## Quickstart

```bash
npm install
cp .env.example .env         # then fill in the tokens (see below)
npm run doctor               # preflight: pings Slack auth, Ledger, RTS, Anthropic
npm run dev                  # run the agent in Socket Mode
```

`.env` keys (`SLACK_BOT_TOKEN` xoxb · `SLACK_APP_TOKEN` xapp · `SLACK_SIGNING_SECRET` · `SLACK_WORKSPACE_TOKEN` xoxp — RTS searches _as this user_ · `LEDGER_CHANNEL_ID` C… · `ANTHROPIC_API_KEY`). See **[SETUP.md](SETUP.md)** for the full Slack app walkthrough + `slack-app-manifest.yaml`.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Vitest — full suite (65 tests). Run before every commit. |
| `npx tsc -p tsconfig.json --noEmit` | Typecheck (also the gate for `src/app.ts`, which isn't unit-tested). |
| `npm run build` | `tsc` build. |
| `npm run doctor` | Preflight diagnostics against live Slack + Anthropic. |
| `npm run seed -- <CHANNEL_ID>` | Post decision threads into a channel (fresh-workspace helper; bot must be a member). |
| `npm run dev` | Run the agent (Socket Mode). |

## The async observer (phase-2, opt-in)

Beyond the inline observer (which folds a decision into memory on approval), an **async observer** keeps profiles warm from ongoing channel activity, so even the *first* capture in a channel is warm. It's a scheduled, in-process poller that:

- reconciles a **channel registry** from bot membership (excluding the Ledger channel),
- reads each channel's `conversations.history` backlog since the profile cursor,
- **folds when ripe** (an LLM call only when a backlog crosses a threshold; capped per tick),
- advances the delta cursor **only over content it actually folded** (oldest-first, bounded windows) — so a warm capture never searches *less* than what anyone covered (`warm ≤ cold` is an invariant).

It's **off by default** (`OBSERVER_ENABLED=false`) and configured via `OBSERVER_*` env vars (see `.env.example`). Design + build: [`docs/superpowers/specs/2026-07-01-async-observer-design.md`](docs/superpowers/specs/2026-07-01-async-observer-design.md) and [`docs/superpowers/plans/2026-07-01-async-observer-vnext.md`](docs/superpowers/plans/2026-07-01-async-observer-vnext.md).

## Testing

- `npm test` — 65 tests (unit + logic-layer eval), dependency-injected so no live API is needed.
- **The thesis, as a free test:** `eval/harness.test.ts` proves the metadata round-trip, the ≤6-call RTS budget, cursor advance, and the **cold-vs-warm RTS-call drop** — including a *causal* proof that an observer fold reduces a subsequent capture's searches.

## Repo layout

```
src/
  agent/       resolve · gapcheck · synthesize · capture · llm (Anthropic runtime)
  slack/       ledger · thread · canvas · blocks · registry · history
  rts/         search (assistant.search.context) · budget (≤6 guard)
  memory/      observer (consolidate + decision-less fold)
  observer/    loop (runObserverTick — the async poller)
  permissions/ scope (provenance-not-payload + audience gating)
  config.ts · types.ts · app.ts (Bolt wiring) · doctor.ts · seed.ts
test/          Vitest mirror of src/
eval/          in-memory Slack fake + logic-layer / thesis eval
docs/          design specs + implementation plans
```

## Docs

- **[SETUP.md](SETUP.md)** — Slack app setup walkthrough + manifest.
- **[CLAUDE.md](CLAUDE.md)** — codebase guide: architecture, per-file module map, conventions, and hard constraints/gotchas.
- **[UPDATE.md](UPDATE.md)** — current-state handoff (what's done / what's next).
- **[docs/superpowers/](docs/superpowers/)** — full design rationale and task-by-task build plans.

## Status

v1 (capture flow + Slack-native Ledger + inline observer) is **built, reviewed, and validated live** against a real Slack workspace + the Anthropic API. The async observer is **built and unit-proven**, opt-in and off by default — not yet exercised against a live workspace. See `UPDATE.md` for the ranked next steps.

---

*Every live capture and every observer fold spends real Opus tokens. The cold-vs-warm memory win is provable for free via `eval/harness.test.ts` — prefer it over live runs when demonstrating the thesis.*
