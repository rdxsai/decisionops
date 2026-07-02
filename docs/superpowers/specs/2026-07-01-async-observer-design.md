# Async Observer — Design Spec

**Date:** 2026-07-01
**Status:** Approved for planning
**Scope:** Phase-2 subsystem #1 — promote the inline observer to a background poller that keeps entity profiles warm from ongoing channel activity, so **even the first capture in a channel is warm**.

Pairs with the v1 design (`docs/superpowers/specs/2026-06-28-decisionops-design.md`, §10 defers this) and the handoff (`UPDATE.md`, ranked next-step #3).

---

## 1. Summary & wedge

Today the observer is **inline**: it runs only on finalize (`src/memory/observer.ts` `consolidate`), folding an approved decision into the channel's entity profile. Consequence: **capture #1 in a channel is always cold** — no profile, cursor at `"0"`, so the bounded RTS gap-search runs a full cold sweep. Only capture #2+ is warm.

This subsystem makes **capture #1 warm too**. A background poller watches the channels the bot has been invited to, ingests their ongoing activity on an interval, and keeps each channel's profile fresh (cursor advanced, recent threads captured, static refreshed on real drift). When someone finally runs *Capture decision*, the profile and delta cursor already exist, so the live search is pre-bounded.

**Why it matters:** the differentiated bet is *"warm captures search less."* The async observer extends that from "capture #2 onward" to "from the very first capture," which is where the memory moat is most visible in a demo.

**Explicitly out of scope** (a *separate* phase-2 item): the proactive "this thread looks like a decision — capture it?" nudge. This subsystem is **passive profile-warming only** — it never posts, never suggests, never searches RTS. It reads channel history and updates profiles.

---

## 2. Locked design decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Trigger** | Scheduled poll (interval) | Simplest correct design; batches naturally (built-in cost control); reuses the cursor + a decision-less consolidate path; holds no message state in memory; internal apps are exempt from the 2025 `conversations.history` throttle. A few minutes of latency is plenty to warm capture #1. |
| **Per-tick work** | Fold-when-ripe | Below threshold the tick does nothing (accumulate — no write, no cursor move); at/above threshold (or a never-folded channel) it runs one LLM fold, capped per tick. Cost is bounded per tick, not per message. *(Corrected from an earlier "cheap path every tick" — see §6: advancing a cursor without folding is unsound.)* |
| **Opt-in** | Persisted registry, populated from bot membership | A Slack-native `channel_registration` record per channel; entries added when the bot is invited (reconciled from `users.conversations` each tick). Auditable and explicit, while bot-membership stays the permission boundary by construction. |
| **Compute** | Same self-hosted Bolt process, internal interval | No external cron/queue/store. Matches "Slack is the only datastore; self-hosted compute." Process-local state (like the existing `pending` map). |

---

## 3. Architecture

```
╔══════════════════════ SLACK-NATIVE STATE (Ledger, message metadata) ═════════════════════╗
║  entity_profile (channel:C…)   decision_record   channel_registration (NEW)               ║
╚════▲═══════════════════════▲══════════════════════════════════════════════▲══════════════╝
     │ read/write profiles    │ read decisions                registry read/write │
     │                        │                                                    │
  CAPTURE LOOP (foreground)   OBSERVER — INLINE (on finalize)      OBSERVER — ASYNC (NEW)
  user waits; RTS as user     consolidate(decision)               interval poll; history as bot
                                                                  reconcile registry → per channel:
                                                                    history delta → tiered warm → write
```

Two things stay invariant from v1: **all state is Slack message metadata** (the registry is just a new record type), and **permission boundary = bot membership** (the async observer only ever reads channels the bot is in — which is exactly the registry).

---

## 4. Components (new / changed)

| File | Change | Responsibility |
|---|---|---|
| `src/types.ts` | +types, +const | `ChannelRegistration`, `ChannelMessage`, `RecentThread` (reused in `DynamicProfile`) + `CHANNEL_REGISTRATION_EVENT_TYPE` (`decisionops_channel`). |
| `src/slack/ledger.ts` | **changed** | Add `allProfiles(): Promise<EntityProfile[]>` — latest profile per entity in one scan (used once per tick, not per channel). |
| `src/slack/registry.ts` | **new** | `makeRegistry(client, ledgerChannelId, now)` → `listActive/register/deactivate`; `channel_registration` via metadata, latest-wins per channelId. `reconcileRegistry(registry, botMemberships)` → `{added, removed, active}` (returns the post-reconcile active set — no second scan). |
| `src/slack/history.ts` | **new** | Channel-level backlog reader: `conversations.history` since a cursor ts, paginated. Distinct from the thread-level `conversations.replies` in `thread.ts`. Returns `{ts, user, text}[]`. |
| `src/memory/observer.ts` | **changed** | Add `isRipe(prior, count, threshold)` (pure gate) + `observeActivity(...)` (**always folds** a ripe backlog). Extract a shared `buildProfile` core so `consolidate` (decision) and `observeActivity` (activity) don't duplicate. Code owns provenance + the verbatim-ts cursor. |
| `src/observer/loop.ts` | **new** | `runObserverTick(deps)` — reconcile → one batch `allProfiles` → for each active channel, read backlog → `isRipe`? fold (capped) → write. Returns `{folded, skipped, deferred}`. Injected clients (testable). |
| `src/config.ts` | **changed** | `OBSERVER_ENABLED` (default false), `OBSERVER_INTERVAL_MS` (300000), `OBSERVER_CONSOLIDATE_THRESHOLD` (8), `OBSERVER_RECENT_K` (3), `OBSERVER_MAX_FOLDS_PER_TICK` (3). |
| `src/app.ts` | **changed** | After `app.start()`, if enabled, start the interval scheduler with an **overlapping-tick guard**; wire real clients (bot history + ledger + `users.conversations` memberships + `chat.getPermalink`). Gate stays `tsc` + live (not unit-tested). |

---

## 5. Per-tick data flow

```
runObserverTick:
  1. { active } ← reconcileRegistry(registry, users.conversations(bot))   // add new, deactivate departed; returns active set
  2. byEntity  ← index(ledger.allProfiles())                              // ONE batch read per tick (not per channel)
  3. folded = 0
     for each channelId in active:
       prior   ← byEntity.get(channel:channelId) ?? coldProfile(...)
       backlog ← history.readSince(channelId, prior.dynamic.searchCursor.untilTs)   // everything since the cursor
       if backlog.length === 0 OR NOT isRipe(prior, backlog.length, threshold):
            continue                                  // accumulate — NO write, NO cursor move
       if folded ≥ maxFolds: { deferred++; continue } // per-tick Opus ceiling
       window     ← oldest `foldWindow` messages of backlog   // contiguous from the cursor (oldest-first)
       recentRefs ← permalinks+snippets for the K newest of the window
       profile′   ← observeActivity({ llm, prior, messages: window, recentRefs, now })   // folds the window:
                    LLM refresh of static drift + open questions; cursor ← VERBATIM newest FOLDED ts
       ledger.writeProfile(profile′); folded++        // write only on a fold; a backlog > window drains over ticks

isRipe(prior, count, threshold) = count ≥ threshold OR prior.dynamic.searchCursor.untilTs === "0"   // never folded ⇒ warm on first sight
```

---

## 6. Cursor model

One pointer per profile — `dynamic.searchCursor.untilTs` — carries a single meaning, inherited from v1: **everything at or before it is already represented in the profile, so a capture's RTS gap-search need not re-cover it.**

**The correctness invariant (not a nicety):** the observer may advance the cursor **only over content it actually folds into the profile in the same step.** `observeActivity` does exactly that — it advances to the verbatim newest *folded* message ts. A below-threshold tick folds nothing, so it must **not** touch the cursor; the un-folded backlog stays behind an un-advanced pointer, so a later capture's RTS search still covers it. This guarantees **warm ≤ cold**: a warm capture searches *less* than a cold one only for windows the profile already summarizes — never for windows nobody covered.

*(An earlier draft advanced a "cheap" cursor every tick without folding. That is precisely what this invariant forbids: it would let a warm capture skip a window that neither the profile nor the search covers, silently inverting the thesis on any channel that trickles below threshold. The critique caught it; the fold-only rule is the fix.)*

**Windowed, oldest-first.** When a backlog exceeds one fold window (`foldWindow`, default 50 — e.g. cold-start on an established channel), the observer folds the **oldest** window first and advances the cursor only to *that window's* newest ts. Coverage therefore stays contiguous from the cursor, and the un-folded newer tail stays behind an un-advanced pointer (so a capture still live-searches it). A large backlog drains over successive ticks. *(A second review pass caught a residual violation here — capping the LLM's input to the 50 newest messages while advancing the cursor to the global newest would strand the older tail. The oldest-first window fixes it: what the cursor claims covered is exactly what was folded.)*

Observer and capture read from **different sources** (history-as-bot vs RTS-as-user) but off the **same** boundary — sound *only* because the boundary now provably tracks folded coverage, not mere reads.

**Monotonic + verbatim:** `observeActivity` sets `cursor =` the newest folded message's own ts string, guarded so it never drops below the prior cursor. It stores the pristine Slack ts (no `Number()` round-trip, which truncates the microsecond suffix). **Idempotency:** re-reading overlap is safe — the cursor only moves forward on folds, the profile is latest-wins, `recentThreads` is bounded. Read with `oldest = cursor`.

---

## 7. Cost & safety

- **Bounded Opus spend.** Folds fire only on a ripe backlog **and** are capped per tick (`OBSERVER_MAX_FOLDS_PER_TICK`), so cost is bounded per tick regardless of chatter. Honest caveat: the ripeness gate keys on message *volume*, not decision *relevance* (true relevance-gating is the out-of-scope nudge detector) — so a busy channel folds recurrently; the per-tick cap is the pragmatic ceiling. Below threshold, a tick is pure code (no LLM).
- **Bounded surface:** only registered (bot-member) channels; interval + threshold + fold-cap configurable; `OBSERVER_ENABLED` kill-switch (default off).
- **History reads:** internal app is throttle-exempt; still paginate politely and stop at the cursor. One batch profile read per tick (not per channel).
- **Overlapping-tick guard:** a single in-flight flag in `app.ts`; if a tick is still running when the interval fires, skip. (App-level glue — gated by `tsc` + a live run, not unit-tested.)
- **Permissions & the laundering trap.** The observer runs as the **bot** and only touches channels the bot is in (= the registry) — the boundary holds by construction. `recentThreads` are **provenance-not-payload** (permalinks + snippets ≤160 chars), **but they carry no `visibility` tag and do NOT pass through `scope.ts`** — they are bot-visible, **same-channel-only** provenance. This is safe *today* because profiles are 1:1 channel-keyed (post the option-1 fix): a `channel:C` profile holds only C's own messages and only ever feeds C's own brief, whose audience already sees C. It is a **latent laundering hole**: the future `project:`-level cross-channel keying refinement MUST tag observed refs with their source-channel visibility and gate them through `scope.ts` before inlining them into a broader-audience brief. (Contrast the v1 RTS path, safe because it searches as-the-user and its `ContextRef`s carry `visibility`.)

---

## 8. Interfaces (sketch)

```ts
interface ChannelRegistration { recordType: "channel_registration"; channelId: string; active: boolean; registeredAt: string }
interface RecentThread { permalink: string; snippet: string; ts: string }   // reused from DynamicProfile
interface ChannelMessage { ts: string; user: string; text: string }

interface Registry {
  listActive(): Promise<string[]>;
  register(channelId: string): Promise<void>;
  deactivate(channelId: string): Promise<void>;
}
function makeRegistry(client: LedgerClient, ledgerChannelId: string, now: () => string): Registry;
function reconcileRegistry(registry: Registry, botMemberships: string[]):
  Promise<{ added: string[]; removed: string[]; active: string[] }>;   // returns post-reconcile active set

interface HistoryReader { readSince(channelId: string, afterTs: string): Promise<ChannelMessage[]> }

// Ledger gains a batch read used once per tick:
interface Ledger { /* …existing… */ allProfiles(): Promise<EntityProfile[]> }

function isRipe(prior: EntityProfile, messageCount: number, threshold: number): boolean;

function observeActivity(a: {
  llm: Llm; prior: EntityProfile; messages: ChannelMessage[]; recentRefs: RecentThread[]; now: string;
}): Promise<EntityProfile>;   // ALWAYS folds; code owns provenance + cursor (verbatim newest folded ts)

function runObserverTick(deps: {
  ledger: Ledger; registry: Registry; history: HistoryReader;
  permalink: (channelId: string, ts: string) => Promise<string>;
  llm: Llm; botMemberships: () => Promise<string[]>;
  threshold: number; recentK: number; foldWindow: number; maxFolds: number; now: () => string;
}): Promise<{ folded: number; skipped: number; deferred: number }>;
```

---

## 9. Testing (TDD, DI — all free, no live API)

1. **`test/slack/registry.test.ts`** — register / listActive / deactivate round-trip via a fake ledger; `reconcileRegistry` diff (memberships → added/removed); latest-wins on re-register.
2. **`test/slack/history.test.ts`** — delta read stops at cursor; pagination; `oldest` boundary; empty result.
3. **`test/memory/observer.test.ts`** (extend) — `isRipe`: ripe at/above threshold, not below, always ripe when never folded. `observeActivity`: folds (LLM refreshes static), keeps code-owned provenance, cursor = **verbatim** newest folded ts, never moves backward.
4. **`test/observer/loop.test.ts`** — `runObserverTick` with fakes: ripe channel folds + advances cursor + writes; a below-threshold already-folded channel → **no fold, no write, cursor unchanged** (pins the warm ≤ cold invariant); per-tick fold cap defers the rest. (The overlapping-tick guard lives in `app.ts`, gated by `tsc` + a live run — not unit-tested.)
5. **`eval/harness.test.ts`** (extend) — **the thesis metric, made causal**: the *same* profile-aware capture LLM runs cold vs. observed; its gap-check searches only while the injected profile doesn't already cover the area, so the search-count drop is *caused by* the observer's fold, not by two different scripts. Prints `cold=N observed=0`. Free, no live cost.
6. `src/app.ts` — gate stays `tsc --noEmit` + a live run, per project convention.

---

## 10. Risks & open items

- **Ledger growth / compaction (from the critique).** `getProfile`/`allProfiles`/registry reads each scan the append-only Ledger channel; the observer adds a new profile record per fold. v-next keeps per-tick cost bounded in channel count (one batch `allProfiles` read + writes only on folds), but the Ledger still grows unbounded over time. **Compaction** (periodically rewriting a snapshot and pruning superseded records) is a roadmap item, not v-next.
- **Cold-start (from the critique, refined 2nd pass).** On a cold cursor the history reader pulls a channel's entire history into memory; the fold then consumes it **oldest-first in `foldWindow` chunks over successive ticks**, so the cursor never claims more than was folded (contiguous coverage). Fine at v-next scale (single workspace, seeded/low-volume channels); the only unbounded piece left is the in-memory *read* of a very large channel — windowed reads (not just windowed folds) are deferred.
- **Registry exclusion.** If a user wants a bot-member channel *excluded* from observation, pure membership-reconciliation can't express it. Deferred: an explicit deny flag (the `channel_registration` record already carries `active`, so it's a small extension).
- **Process-local scheduler.** Like the v1 `pending` map, the interval is process-local; a restart re-reconciles from the Ledger + memberships (durable) but loses the in-flight flag (harmless). Multi-instance would need a lock; out of scope.
- **`chat.getPermalink` shape** — `app.ts` resolves permalinks for only the K newest messages per fold; the reader itself returns `{ts,user,text}`. Verify the response field against live like the RTS-shape fix in `UPDATE.md`; the resolver falls back to a `slack://` deep link if absent.
- **recentThreads laundering (cross-ref §7).** Observed `recentThreads` carry no `visibility` and bypass `scope.ts`; safe only under today's 1:1 channel-keying. The `project:`-level keying refinement MUST add visibility tagging + scoping before it ships — tracked here so it isn't forgotten.
- **Cursor format — resolved.** Compare `ts` numerically for ordering only; **store** the verbatim newest-folded `ts` string (no `Number()` round-trip), so the cursor stays a pristine Slack ts and the `oldest`/`>afterTs` boundary is exact.

---

## 11. Next step

writing-plans → a task-by-task implementation plan (registry → history reader → `observeActivity` → `runObserverTick` → app wiring → eval), TDD throughout, then a separate-agent critique before build.
