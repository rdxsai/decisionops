# DecisionOps — Handoff / Status

**Last updated:** 2026-07-01 · **Branch:** `async-observer` · **Tests:** 46 passing (18 files), `tsc --noEmit` clean.

This is the pick-up-here doc for the next agent. Pair it with `CLAUDE.md` (codebase guide), the spec (`docs/superpowers/specs/2026-06-28-decisionops-design.md`), and the build plan (`docs/superpowers/plans/2026-06-28-decisionops-v1.md`).

---

## TL;DR
v1 is **built, reviewed, merged, and validated LIVE** against a real Slack workspace + the Anthropic API. A real "Capture decision" produced an accurate Canvas brief + approval card, and Approve persisted the decision + profile into the Slack-native Ledger. The foundation is solid and proven. Phase 2 has not been started (each item needs its own design→plan→build).

**Watch the API budget** — every live capture costs real Opus tokens. Don't do needless live runs; the memory win is provable for free via `eval/harness.test.ts`.

---

## What's done

### v1 (capture-flow, merged)
The complete message-shortcut pipeline, built via subagent-driven development (fresh implementer per task + spec/quality review each + a whole-branch review). 11 tasks, all reviewed clean. See `git log`.

- Message shortcut `capture_decision` → hydrate thread → **resolve** decision → **recall** entity profile from Ledger (cold-start inline if new) → **bounded (≤6) delta-scoped RTS** gap-search → **synthesize** brief → **Canvas** brief → **Block Kit** approval → **finalize** (canvas update + final post + write decision_record + **inline observer** consolidates → write entity_profile).
- **Slack-native Ledger**: all state is message metadata in one private channel. No external datastore.
- **Own-the-loop LLM** via Anthropic Messages API; static profile prompt-cached, dynamic profile as an Opus-4.8 mid-conversation system message; bounded RTS tool loop.
- **Permission model**: RTS searches as the user; provenance-not-payload; audience-scoped rendering (verified no laundering path).
- **Eval**: `eval/harness.test.ts` proves metadata round-trip, the ≤6 budget cap, cursor advance, and the **cold-vs-warm RTS-call drop** (prints `cold=3 warm=0`) — the thesis, as a free test.

### Verification toolkit (merged)
- `npm run doctor` — preflight diagnostics (`src/doctor.ts`, 7 unit tests).
- `npm run seed -- <CHANNEL_ID>` — seed decision threads into a channel (`src/seed.ts`).
- `slack-app-manifest.yaml` + `SETUP.md` — turnkey Slack app setup.
- dotenv wired into `app.ts`/`doctor.ts`.

### Live validation (2026-06-29) — the important part
Ran against a real Pro workspace ("personal") + real Anthropic:
- `npm run doctor` → **all 5 checks green** (bot auth, user auth, Ledger channel + membership, RTS reachable/`semantic=false`, Anthropic model). Every mock-only integration assumption held against live APIs.
- Seeded `#decisions-ledger` with 4 decision threads (`npm run seed`).
- A real **Capture decision** on the DynamoDB→Postgres thread produced an accurate brief (correct decision, both options, real open questions) + approval card. Approve produced a "Decided: …" post.
- **Ledger verified** (free `conversations.history` scan): `decisionops_record` (status=decided, `approvers=[<real user>]`, entities extracted) **and** `decisionops_profile` (observer ran: cursor advanced to the capture ts, decision folded into `inFlightDecisions`). The Slack-is-the-whole-datastore thesis works live.

---

## Fixes made during the live run (already committed in `7a89821`)
1. **RTS response shape.** `assistant.search.context` returns `results` grouped by content type (`{messages,files,channels,users}`), **not** a flat array — our mock was wrong and the live call crashed with `results.map is not a function`. Fixed `src/rts/search.ts` to read `results.messages` with defensive field mapping, and updated **every** RTS mock (search/gapcheck/capture tests + `eval/fakeSlack.ts`) to the real shape. *(Lesson: the real message-item field names are still unconfirmed — the live workspace had 0 indexed results — so the item mapping uses fallbacks; verify field names against a workspace with indexed data before relying on snippet content.)*
2. **Cost tuning.** `src/agent/llm.ts` `BASE` now: no adaptive thinking, `effort:"low"`, `max_tokens:4096` (thinking tokens were the expensive part). Kept Opus 4.8 so the mid-conversation system message stays valid.

---

## Known issues / refinements (not blockers)
- **Primary-entity keying — FIXED (2026-07-01).** `runCapture` now keys the warm-start profile on the **channel seed** (`src/agent/capture.ts`), never `resolved.entities[0]` (which could be a person). `finalize` reuses `cap.profile.entityId` (`src/app.ts`) so the read and write keys can't diverge — a first review pass caught that the original fix only touched the read side, which would have made warm-start miss *forever* in the person-first case. A round-trip test pins read==write. Project-level cross-channel keying (preferring a `project:` entity) is deferred: it needs `resolve.ts` to emit canonical `project:` ids **and** visibility-scoping of observed `recentThreads` (see the async-observer spec §7).
- **Owners often empty.** Seed threads reference "eng-lead"/"finance" as plain text (no real `@mentions`), so `synthesize` returns no structured owners → "no follow-up owners". Expected on synthetic data; real threads with real mentions should populate owners.
- **Minor review findings (accepted for v1)** are logged in `.superpowers/sdd/progress.md` (git-ignored). Notable ones a phase-2 hardening pass could pick up: Ledger `conversations.history` pagination is untested; `structured()` throws on a no-text model response; a few test-coverage gaps (dm-audience scoping, etc.). None are correctness bugs.
- **`reject` runs the observer?** Already fixed — `app.ts` gates `consolidate`+`writeProfile` on `status==="decided"`, so a rejected decision is recorded but not folded into memory.

---

## Cost guidance (READ THIS)
- Each live capture = several Opus calls (resolve + gapcheck loop + synthesize) + one on Approve (observer). Even cost-tuned, it's real money. **Do not trigger live captures to "check" things** — use unit tests / the free `eval` / free Slack API probes (`conversations.history`, `assistant.search.context` via curl) instead.
- **Next cost lever if needed:** switch the agent's routine calls to **Haiku 4.5**. BUT mid-conversation `role:"system"` messages are Opus-4.8-only, so you must first fold the dynamic profile into the user turn (edit `dynamicSystemMessage` usage in `gapcheck.ts`/`synthesize.ts`, drop `thinking`/`effort` for Haiku, update the `llm.test.ts`/gapcheck/synthesize tests). ~15-line refactor; do it as one reviewed change, then verify with ONE live capture.

---

## How to resume
1. `npm install && npm test && npx tsc -p tsconfig.json --noEmit` — confirm green (44 tests, clean).
2. To run live: ensure `.env` is filled (it was, on the original machine), `npm run doctor` (get green), `npm run dev`, then trigger the shortcut in Slack. The bot is currently a member of `#decisions-ledger` only; invite it wherever you test.
3. Free ways to inspect live state without spending: `conversations.history?include_all_metadata=true` on the Ledger channel to see records; `assistant.search.context` via curl (user token) to see RTS shape/results.

---

## What's next — ranked

1. **Demo + submission assets (highest ROI for the hackathon).** Record the ~3-min demo (a live capture + the Ledger records), draw the architecture diagram, and set up the required **developer sandbox** shared with `slackhack@salesforce.com` + `testing@devpost.com` (the current Pro workspace is fine for dev, but submission needs the sandbox — note the sandbox is a Grid org, so RTS must use a workspace-level token and you can't import backdated history; seed via `npm run seed`). Decide the **track** (New Slack Agent is the fit; Organizations requires Marketplace submission).
2. **Entity-keying refinement — DONE (2026-07-01).** Channel-keyed, read==write, round-trip test. See the fixed known-issue above.
3. **Phase-2 subsystem — async/event-driven observer — SPEC + PLAN READY (2026-07-01).** Brainstorm→spec→plan complete and adversarially reviewed (3 agent passes: critique → verify → focused check; verdict *sound to build*). See `docs/superpowers/specs/2026-07-01-async-observer-design.md` + `docs/superpowers/plans/2026-07-01-async-observer-vnext.md`. Design: scheduled poll · fold-when-ripe (LLM only on a ripe backlog, capped per tick) · registry reconciled from bot membership · passive-only. Core invariant: the delta cursor advances **only over folded content** (oldest-first bounded windows) ⇒ warm ≤ cold. Ready to build subagent-driven.
4. **Phase-2 — proactive nudge** ("this thread looks like a decision — capture it?") in opted-in channels. Needs a detection classifier + ephemeral suggestion; keep it opt-in (no broad retrieval before a human approves).
5. **Phase-2 — seeded real-workspace retrieval-quality eval** (Layer-2): import/seed a workspace with planted relationships, measure recall/precision + cold-vs-warm on real volume (see spec §9; note RTS indexing lag — build the sentinel probe).

Process note: this project used the superpowers skills (brainstorming → writing-plans → subagent-driven-development → finishing-a-development-branch). Continue that for any phase-2 subsystem — do NOT start coding a feature without a design + plan.
