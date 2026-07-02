# Async Observer (v-next) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a background poller that keeps `channel:…` entity profiles warm from ongoing channel activity, so a *Capture decision* in a channel the observer has already folded starts warm (populated static profile → fewer open questions → fewer live searches) — and **never** searches less than a cold capture would.

**Architecture:** A scheduled, in-process poll loop (`runObserverTick`) reconciles a Slack-native channel **registry** (populated from bot membership), then for each registered channel reads the `conversations.history` backlog since the profile's cursor. When that backlog is **ripe** (≥ threshold new messages, or the channel has never been folded), it runs one LLM **fold** — decision-less consolidation into `static` + open questions — refreshes provenance, and **advances the cursor to exactly the newest folded message**. Below threshold it does nothing (accumulates). All state stays in Ledger message metadata; nothing is posted or searched.

**Tech Stack:** TypeScript (ESM, strict), `@slack/bolt` + `@slack/web-api`, `@anthropic-ai/sdk` (`claude-opus-4-8`), Vitest, `tsx`.

Design spec: `docs/superpowers/specs/2026-07-01-async-observer-design.md`.

## Changelog (post-critique rework)

A pre-build adversarial review caught a correctness bug and several risks; this plan is the corrected version:
- **C1 (was Critical):** the original "cheap path every tick" advanced the shared cursor without folding content, so warm captures could miss context cold ones find. **Fix:** the cursor advances *only* over folded content; below threshold the observer accumulates (no write, no cursor move). Warm ≤ cold is now invariant.
- **C1 residual (2nd review pass):** a token cap (`slice(0,50)`) still let the cursor jump past un-folded messages on a backlog > 50 — exactly the cold-start path. **Fix:** the loop folds **oldest-first in a bounded `foldWindow`** and advances the cursor only to the newest *folded* ts; larger backlogs drain over successive ticks. `isRipe` keys dormancy on `cursor === "0"` (not summary emptiness), so a thin fold can't cause a re-fold thrash.
- **I2:** removed the false "audience-scoped via scope.ts" claim; `recentThreads` are documented as bot-visible, **same-channel-only** provenance, safe under today's 1:1 channel-keying (see Global Constraints + spec §7).
- **I3:** added a per-tick fold cap (`OBSERVER_MAX_FOLDS_PER_TICK`) to bound Opus spend.
- **I4:** the loop batch-reads all profiles once (`ledger.allProfiles()`), reconcile returns the active set (one registry scan), and writes happen only on folds.
- **I5:** the eval now drives search count *causally* from the observer-written profile (a profile-aware scripted LLM), not two different scripts.
- **M1:** cursor stores the verbatim newest ts string (no `Number` round-trip). **M3:** the overlapping-tick guard lives in `app.ts` and is not claimed unit-tested.

## Global Constraints

Every task implicitly includes these:

- **Persistence:** Slack message metadata is the *only* datastore. The registry is a new record type in the same Ledger channel; append-only, latest-wins per key. No DB/file/queue.
- **Passive only:** the observer never posts, never suggests a capture, never calls RTS. It reads `conversations.history` (as the bot) and writes profiles.
- **Warm ≤ cold (the cursor invariant):** `dynamic.searchCursor.untilTs` means *"everything at or before this ts is already represented in the profile."* It may advance **only** over content that was actually folded into the profile in the same step. Never advance it on a non-folding tick.
- **Permission boundary = bot membership:** the observer only reads channels the bot is a member of (= the registry). `recentThreads` hold permalinks + snippets ≤160 chars (**provenance, not payload**). They are **bot-visible, same-channel-only**: safe to inline into that channel's own brief (whose audience already sees the channel), but they carry no `visibility` tag and MUST NOT be inlined into a broader-audience brief. This holds because profiles are 1:1 channel-keyed today; the future `project:`-level keying refinement must add visibility scoping to `recentThreads` before it ships (see spec §7/§10).
- **Model:** `claude-opus-4-8`. Reuse the cost-tuned `Llm` in `src/agent/llm.js` as-is. The fold LLM fires only on ripe backlogs, capped per tick.
- **ESM imports:** intra-repo `src` imports use the `.js` extension even from `.ts`. Test files omit `.js`.
- **TDD:** failing test → watch it fail → minimal code → keep the whole suite green (`npm test`) + `npx tsc -p tsconfig.json --noEmit`. `src/app.ts` is not unit-tested — its gate is `tsc` + a live run.
- **Slack timestamps:** compare numerically (`Number(ts)`) for ordering only; **store** the verbatim ts string (never the `Number`-round-tripped form) so the cursor stays a pristine Slack ts.

## File Structure

```
src/
  types.ts                 # + ChannelMessage, ChannelRegistration, RecentThread, CHANNEL_REGISTRATION_EVENT_TYPE
  slack/
    ledger.ts      (mod)   # + allProfiles(): batch-read latest profile per entity
    registry.ts    (new)   # channel_registration records + makeRegistry + reconcileRegistry (returns active set)
    history.ts     (new)   # conversations.history backlog reader (channel-level)
  memory/
    observer.ts    (mod)   # + isRipe (pure predicate) + observeActivity (fold); extract buildProfile
  observer/
    loop.ts        (new)   # runObserverTick — reconcile -> batch profiles -> ripe? -> fold (capped) -> write
  config.ts        (mod)   # + observerEnabled / IntervalMs / Threshold / RecentK / MaxFoldsPerTick
  app.ts           (mod)   # start the interval scheduler (guarded) when enabled
test/
  slack/ledger.test.ts      (mod)   # + allProfiles
  slack/registry.test.ts    (new)
  slack/history.test.ts      (new)
  memory/observer.test.ts    (mod)
  observer/loop.test.ts       (new)
  config.test.ts             (mod)
eval/
  fakeSlack.ts     (mod)   # + historyClient / seedChannel / memberships / permalink
  harness.test.ts  (mod)   # + (e) observer causally warms a capture
```

---

### Task 1: Domain types + channel registry

**Files:**
- Modify: `src/types.ts`
- Create: `src/slack/registry.ts`
- Test: `test/slack/registry.test.ts`

**Interfaces:**
- Consumes: `LedgerClient` from `../slack/ledger` (existing).
- Produces:
  - `interface RecentThread { permalink: string; snippet: string; ts: string }` and `DynamicProfile.recentThreads: RecentThread[]`
  - `interface ChannelMessage { ts: string; user: string; text: string }`
  - `interface ChannelRegistration { recordType: "channel_registration"; channelId: string; active: boolean; registeredAt: string }`, `CHANNEL_REGISTRATION_EVENT_TYPE = "decisionops_channel"`
  - `makeRegistry(client: LedgerClient, ledgerChannelId: string, now: () => string): Registry`
  - `interface Registry { listActive(): Promise<string[]>; register(channelId: string): Promise<void>; deactivate(channelId: string): Promise<void> }`
  - `reconcileRegistry(registry: Registry, botMemberships: string[]): Promise<{ added: string[]; removed: string[]; active: string[] }>` — returns the post-reconcile active set (= deduped memberships) so callers need not re-scan.

- [ ] **Step 1: Add the domain types to `src/types.ts`**

Extract the recent-thread shape into a named type and reuse it in `DynamicProfile`. Replace the `recentThreads` line inside `interface DynamicProfile` — change:

```typescript
  recentThreads: { permalink: string; snippet: string; ts: string }[];
```
to:
```typescript
  recentThreads: RecentThread[];
```

Then append at the end of `src/types.ts`:

```typescript
export interface RecentThread {
  permalink: string;
  snippet: string;
  ts: string;
}

export interface ChannelMessage {
  ts: string;
  user: string;
  text: string;
}

export interface ChannelRegistration {
  recordType: "channel_registration";
  channelId: string;
  active: boolean;
  registeredAt: string;
}

export const CHANNEL_REGISTRATION_EVENT_TYPE = "decisionops_channel";
```

- [ ] **Step 2: Write the failing test**

```typescript
// test/slack/registry.test.ts
import { describe, it, expect } from "vitest";
import { makeRegistry, reconcileRegistry } from "../../src/slack/registry";
import type { LedgerClient } from "../../src/slack/ledger";

function fakeClient() {
  const messages: any[] = [];
  const client: LedgerClient = {
    async chatPostMessage(a) { messages.unshift({ metadata: a.metadata }); }, // newest-first, like Slack
    async conversationsHistory() { return { messages }; },
  };
  return { client, messages };
}

describe("Registry", () => {
  it("registers a channel and lists it as active", async () => {
    const { client } = fakeClient();
    const reg = makeRegistry(client, "CLEDGER", () => "t");
    await reg.register("C1");
    expect(await reg.listActive()).toEqual(["C1"]);
  });

  it("latest-wins: a later deactivate hides an earlier register", async () => {
    const { client } = fakeClient();
    const reg = makeRegistry(client, "CLEDGER", () => "t");
    await reg.register("C1");
    await reg.deactivate("C1");
    expect(await reg.listActive()).toEqual([]);
  });

  it("reconcile registers new memberships, deactivates departed, and returns the active set", async () => {
    const { client } = fakeClient();
    const reg = makeRegistry(client, "CLEDGER", () => "t");
    await reg.register("C1"); // previously active
    const r1 = await reconcileRegistry(reg, ["C1", "C2"]); // bot now in C1, C2
    expect(r1.added).toEqual(["C2"]);
    expect(r1.removed).toEqual([]);
    expect(r1.active.sort()).toEqual(["C1", "C2"]);
    const r2 = await reconcileRegistry(reg, ["C2"]); // bot left C1
    expect(r2.added).toEqual([]);
    expect(r2.removed).toEqual(["C1"]);
    expect(r2.active).toEqual(["C2"]);
    expect(await reg.listActive()).toEqual(["C2"]);
  });
});
```

- [ ] **Step 3: Run it to confirm failure**

Run: `npx vitest run test/slack/registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/slack/registry'`.

- [ ] **Step 4: Implement `src/slack/registry.ts`**

```typescript
// src/slack/registry.ts
import { CHANNEL_REGISTRATION_EVENT_TYPE, type ChannelRegistration } from "../types.js";
import type { LedgerClient } from "./ledger.js";

export interface Registry {
  listActive(): Promise<string[]>;
  register(channelId: string): Promise<void>;
  deactivate(channelId: string): Promise<void>;
}

export function makeRegistry(client: LedgerClient, ledgerChannelId: string, now: () => string): Registry {
  async function readAll(): Promise<ChannelRegistration[]> {
    const out: ChannelRegistration[] = [];
    let cursor: string | undefined;
    do {
      const res = await client.conversationsHistory({ channel: ledgerChannelId, include_all_metadata: true, cursor });
      for (const m of res.messages ?? []) {
        if (m.metadata?.event_type === CHANNEL_REGISTRATION_EVENT_TYPE) {
          out.push(m.metadata.event_payload as ChannelRegistration);
        }
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out; // newest-first
  }

  function write(reg: ChannelRegistration): Promise<void> {
    return client.chatPostMessage({
      channel: ledgerChannelId,
      text: `Registration: ${reg.channelId} [${reg.active ? "active" : "inactive"}]`,
      metadata: { event_type: CHANNEL_REGISTRATION_EVENT_TYPE, event_payload: reg },
    });
  }

  return {
    async listActive() {
      const seen = new Set<string>();
      const active: string[] = [];
      for (const r of await readAll()) { // newest-first => first seen is the latest state
        if (seen.has(r.channelId)) continue;
        seen.add(r.channelId);
        if (r.active) active.push(r.channelId);
      }
      return active;
    },
    register: (channelId) => write({ recordType: "channel_registration", channelId, active: true, registeredAt: now() }),
    deactivate: (channelId) => write({ recordType: "channel_registration", channelId, active: false, registeredAt: now() }),
  };
}

export async function reconcileRegistry(
  registry: Registry,
  botMemberships: string[],
): Promise<{ added: string[]; removed: string[]; active: string[] }> {
  const current = await registry.listActive();
  const currentSet = new Set(current);
  const memberSet = new Set(botMemberships);
  const added: string[] = [];
  const removed: string[] = [];
  for (const id of botMemberships) if (!currentSet.has(id)) { await registry.register(id); added.push(id); }
  for (const id of current) if (!memberSet.has(id)) { await registry.deactivate(id); removed.push(id); }
  // After reconcile every membership is registered-active and every departed channel is inactive,
  // so the active set is exactly the (deduped) memberships — no second scan needed.
  return { added, removed, active: [...new Set(botMemberships)] };
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npx vitest run test/slack/registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/slack/registry.ts test/slack/registry.test.ts
git commit -m "feat: channel registry (Slack-native, reconciled from bot membership)"
```

---

### Task 2: Channel history backlog reader

**Files:**
- Create: `src/slack/history.ts`
- Test: `test/slack/history.test.ts`

**Interfaces:**
- Consumes: `ChannelMessage` from `../types`.
- Produces:
  - `interface HistoryClient { conversationsHistory(a: { channel: string; oldest?: string; cursor?: string; limit?: number }): Promise<{ messages: Array<{ ts: string; user?: string; text?: string }>; response_metadata?: { next_cursor?: string } }> }`
  - `interface HistoryReader { readSince(channelId: string, afterTs: string): Promise<ChannelMessage[]> }`
  - `makeHistory(client: HistoryClient): HistoryReader` — returns messages strictly newer than `afterTs` (numeric compare), newest-first, paginated. `afterTs === "0"` means "all history".

**Note (cold-start scale, spec §10):** on a cold cursor (`"0"`) this reads the channel's full history so the first fold has contiguous coverage from the beginning (required by the warm ≤ cold invariant — a windowed cold read would leave an un-folded gap behind the advanced cursor). Fine at v-next scale (single workspace, seeded/low-volume channels); windowed backfill with correct cursor semantics is a documented roadmap item, not a v-next cap.

- [ ] **Step 1: Write the failing test**

```typescript
// test/slack/history.test.ts
import { describe, it, expect, vi } from "vitest";
import { makeHistory, type HistoryClient } from "../../src/slack/history";

describe("HistoryReader", () => {
  it("returns only messages strictly newer than the cursor and passes oldest", async () => {
    const client: HistoryClient = {
      conversationsHistory: vi.fn(async () => ({
        messages: [
          { ts: "300", user: "U1", text: "new" },
          { ts: "200", user: "U2", text: "at cursor" },
          { ts: "100", user: "U3", text: "old" },
        ],
      })),
    };
    const msgs = await makeHistory(client).readSince("C1", "200");
    expect(msgs.map((m) => m.ts)).toEqual(["300"]);
    expect(client.conversationsHistory).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1", oldest: "200" }));
  });

  it("pages until next_cursor is exhausted", async () => {
    const page = vi.fn()
      .mockResolvedValueOnce({ messages: [{ ts: "300", user: "U1", text: "a" }], response_metadata: { next_cursor: "X" } })
      .mockResolvedValueOnce({ messages: [{ ts: "250", user: "U2", text: "b" }] });
    const msgs = await makeHistory({ conversationsHistory: page } as any).readSince("C1", "0");
    expect(msgs.map((m) => m.ts)).toEqual(["300", "250"]);
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("passes no oldest for a cold cursor of 0", async () => {
    const client: HistoryClient = { conversationsHistory: vi.fn(async () => ({ messages: [] })) };
    await makeHistory(client).readSince("C1", "0");
    expect(client.conversationsHistory).toHaveBeenCalledWith(expect.objectContaining({ oldest: undefined }));
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run test/slack/history.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/slack/history.ts`**

```typescript
// src/slack/history.ts
import type { ChannelMessage } from "../types.js";

export interface HistoryClient {
  conversationsHistory(a: {
    channel: string; oldest?: string; cursor?: string; limit?: number;
  }): Promise<{
    messages: Array<{ ts: string; user?: string; text?: string }>;
    response_metadata?: { next_cursor?: string };
  }>;
}

export interface HistoryReader {
  readSince(channelId: string, afterTs: string): Promise<ChannelMessage[]>;
}

const numTs = (ts: string): number => Number(ts) || 0;

export function makeHistory(client: HistoryClient): HistoryReader {
  return {
    async readSince(channelId, afterTs) {
      const out: ChannelMessage[] = [];
      let cursor: string | undefined;
      do {
        const res = await client.conversationsHistory({
          channel: channelId,
          oldest: afterTs === "0" ? undefined : afterTs, // "0" = cold => all history
          cursor, limit: 200,
        });
        for (const m of res.messages ?? []) {
          // conversations.history returns newest-first; keep only strictly after the cursor.
          if (numTs(m.ts) > numTs(afterTs)) out.push({ ts: m.ts, user: m.user ?? "", text: m.text ?? "" });
        }
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return out; // newest-first
    },
  };
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run test/slack/history.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/slack/history.ts test/slack/history.test.ts
git commit -m "feat: channel-level conversations.history backlog reader"
```

---

### Task 3: `isRipe` + decision-less fold (`observeActivity`)

**Files:**
- Modify: `src/memory/observer.ts`
- Test: `test/memory/observer.test.ts`

**Interfaces:**
- Consumes: `Llm`, `cachedSystem` (already imported); `EntityProfile`, `ChannelMessage`, `RecentThread` from `../types`; the existing private `SCHEMA`.
- Produces:
  - `isRipe(prior: EntityProfile, messageCount: number, threshold: number): boolean` — pure gate: ripe iff `messageCount >= threshold` OR the channel has never been folded (`prior.dynamic.searchCursor.untilTs === "0"`).
  - `observeActivity(a: { llm: Llm; prior: EntityProfile; messages: ChannelMessage[]; recentRefs: RecentThread[]; now: string }): Promise<EntityProfile>` — **always folds** (one LLM call), refreshes `recentThreads` from `recentRefs`, and advances the cursor to the **verbatim newest folded ts** (monotonic; never below prior). The loop decides *whether* to call it via `isRipe`, so the cursor only ever advances over folded content.
  - Refactor: private `buildProfile(prior, out, newCursorTs, now)` shared by `consolidate` and `observeActivity`.

- [ ] **Step 1: Refactor `consolidate` to use a shared `buildProfile` (behavior-preserving)**

In `src/memory/observer.ts`, extend the type import:

```typescript
import type { DecisionRecord, EntityId, EntityProfile, ChannelMessage, RecentThread } from "../types.js";
```

Add these helpers just above `export async function consolidate(...)`:

```typescript
const numTs = (ts: string): number => Number(ts) || 0;

// Assemble a profile from an LLM `out`, with code authoritative for the entity id,
// builtAt fallback, delta cursor, and refreshedAt.
function buildProfile(
  prior: EntityProfile,
  out: Pick<EntityProfile, "static" | "dynamic">,
  newCursorTs: string,
  now: string,
): EntityProfile {
  return {
    recordType: "entity_profile",
    entityId: prior.entityId,
    static: { ...out.static, builtAt: out.static.builtAt || prior.static.builtAt },
    dynamic: { ...out.dynamic, searchCursor: { untilTs: newCursorTs }, refreshedAt: now },
  };
}
```

Replace the `return { ... }` at the end of `consolidate` with:

```typescript
  return buildProfile(a.prior, out, a.newCursorTs, a.now);
```

- [ ] **Step 2: Confirm the existing observer + eval tests still pass (no behavior change)**

Run: `npx vitest run test/memory/observer.test.ts eval/harness.test.ts`
Expected: PASS (unchanged — the refactor is behavior-preserving).

- [ ] **Step 3: Write the failing `isRipe` + `observeActivity` tests**

Append to `test/memory/observer.test.ts` (add `isRipe, observeActivity` to the import from `../../src/memory/observer`, and import `EntityProfile`):

```typescript
import { isRipe, observeActivity } from "../../src/memory/observer";
import type { EntityProfile } from "../../src/types";

const warmPrior = (): EntityProfile => ({
  recordType: "entity_profile", entityId: "channel:C1",
  static: { summary: "billing area", keyPeople: [], keySystems: [], decisionNorms: "", builtAt: "t0" },
  dynamic: { inFlightDecisions: [], recentThreads: [], openQuestions: [], searchCursor: { untilTs: "100" }, refreshedAt: "t0" },
});
const coldPrior = (): EntityProfile => ({
  recordType: "entity_profile", entityId: "channel:C1",
  static: { summary: "", keyPeople: [], keySystems: [], decisionNorms: "", builtAt: "t0" },
  dynamic: { inFlightDecisions: [], recentThreads: [], openQuestions: [], searchCursor: { untilTs: "0" }, refreshedAt: "t0" },
});
const foldLlm = () => {
  const create = vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify({
    static: { summary: "drifted summary", keyPeople: ["U1"], keySystems: [], decisionNorms: "", builtAt: "t0" },
    dynamic: { inFlightDecisions: [], recentThreads: [], openQuestions: ["oq"], searchCursor: { untilTs: "ignored" }, refreshedAt: "ignored" },
  })}]}));
  return { llm: new Llm({ messages: { create } } as any), create };
};
const refs = [{ permalink: "p", snippet: "s", ts: "300" }];

describe("isRipe", () => {
  it("is ripe at/above threshold, not below, and always ripe when never folded (cursor 0)", () => {
    expect(isRipe(warmPrior(), 8, 8)).toBe(true);
    expect(isRipe(warmPrior(), 7, 8)).toBe(false);
    expect(isRipe(coldPrior(), 1, 8)).toBe(true); // never folded: cursor "0"
    // A folded channel (cursor advanced) is threshold-gated even if its summary came back thin —
    // no re-fold-every-tick thrash.
    const thinlyFolded = { ...warmPrior(), static: { ...warmPrior().static, summary: "" } }; // cursor still "100"
    expect(isRipe(thinlyFolded, 3, 8)).toBe(false);
  });
});

describe("observeActivity", () => {
  it("folds: LLM refreshes static, code keeps provenance, cursor = verbatim newest ts", async () => {
    const { llm, create } = foldLlm();
    const profile = await observeActivity({
      llm, prior: warmPrior(),
      messages: [{ ts: "1712345678.000300", user: "U1", text: "a" }, { ts: "1712345678.000250", user: "U2", text: "b" }],
      recentRefs: refs, now: "t1",
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(profile.static.summary).toBe("drifted summary");
    expect(profile.dynamic.recentThreads).toEqual(refs); // code-owned, not the model's []
    expect(profile.dynamic.searchCursor.untilTs).toBe("1712345678.000300"); // verbatim, not Number-mangled
  });

  it("never moves the cursor backward", async () => {
    const { llm } = foldLlm();
    const profile = await observeActivity({
      llm, prior: warmPrior(), // cursor 100
      messages: [{ ts: "50", user: "U1", text: "old" }], recentRefs: refs, now: "t1" });
    expect(profile.dynamic.searchCursor.untilTs).toBe("100");
  });
});
```

- [ ] **Step 4: Run it to confirm failure**

Run: `npx vitest run test/memory/observer.test.ts`
Expected: FAIL — `isRipe` / `observeActivity` not exported.

- [ ] **Step 5: Implement `isRipe` + `observeActivity` in `src/memory/observer.ts`**

Add at the end of the file:

```typescript
// Ripe when there's enough backlog to be worth an LLM fold, or the channel has never
// been folded (cursor still "0") so its very first observation warms it regardless of
// volume. Keyed on the cursor, NOT summary emptiness — so a fold that returns a thin
// summary can't cause a re-fold-every-tick thrash (the cursor advances once folded).
export function isRipe(prior: EntityProfile, messageCount: number, threshold: number): boolean {
  return messageCount >= threshold || prior.dynamic.searchCursor.untilTs === "0";
}

const ACTIVITY_INSTR =
  "You are the memory observer, watching a channel's recent activity (no decision has " +
  "been finalized yet). Fold the recent messages into the entity profile: rewrite `static` " +
  "only if the area's nature, key people, or norms actually drifted, and capture the " +
  "still-open questions the channel is wrestling with. Keep `dynamic` to the delta. Be terse; " +
  "profiles must stay small enough to inject every turn and stable enough to prompt-cache. " +
  "Provenance only — never inline full message bodies.";

// Fold EXACTLY the given messages into the profile. The caller (runObserverTick) passes a
// bounded, contiguous-from-the-cursor window (oldest-first coverage), so folding all of
// them and advancing the cursor to their newest ts keeps coverage contiguous — the cursor
// never jumps past a message that wasn't folded. ALWAYS calls the LLM; the loop gates on isRipe.
export async function observeActivity(a: {
  llm: Llm; prior: EntityProfile;
  messages: ChannelMessage[];
  recentRefs: RecentThread[];
  now: string;
}): Promise<EntityProfile> {
  // Cursor advances to the verbatim newest of exactly the folded messages, guarded monotonic.
  const newCursorTs = a.messages.reduce(
    (max, m) => (numTs(m.ts) > numTs(max) ? m.ts : max),
    a.prior.dynamic.searchCursor.untilTs,
  );
  const out = await a.llm.structured<Pick<EntityProfile, "static" | "dynamic">>({
    system: cachedSystem(ACTIVITY_INSTR, ""),
    messages: [{ role: "user", content:
      `Prior profile:\n${JSON.stringify(a.prior)}\n\n` +
      `Messages to fold (newest first):\n${JSON.stringify(a.messages.map((m) => ({ user: m.user, text: m.text })))}` }],
    schema: SCHEMA as object,
  });
  return buildProfile(
    a.prior,
    { static: out.static, dynamic: { ...out.dynamic, recentThreads: a.recentRefs } },
    newCursorTs, a.now);
}
```

- [ ] **Step 6: Run the tests to confirm they pass**

Run: `npx vitest run test/memory/observer.test.ts`
Expected: PASS (existing 2 + 3 new = 5 tests).

- [ ] **Step 7: Commit**

```bash
git add src/memory/observer.ts test/memory/observer.test.ts
git commit -m "feat: isRipe gate + observeActivity fold (cursor advances only over folded content)"
```

---

### Task 4: Batch profile read + `runObserverTick`

**Files:**
- Modify: `src/slack/ledger.ts`, `test/slack/ledger.test.ts`
- Create: `src/observer/loop.ts`
- Test: `test/observer/loop.test.ts`

**Interfaces:**
- Consumes: `Ledger` + new `allProfiles` from `../slack/ledger`; `Registry` + `reconcileRegistry` from `../slack/registry`; `HistoryReader` from `../slack/history`; `Llm`; `coldProfile` + `isRipe` + `observeActivity` from `../memory/observer`; `entityIdForChannel` from `../types`.
- Produces:
  - `Ledger.allProfiles(): Promise<EntityProfile[]>` — latest profile per entityId (newest-first, deduped), mirroring `allDecisions`.
  - `runObserverTick(deps: { ledger: Ledger; registry: Registry; history: HistoryReader; permalink: (channelId: string, ts: string) => Promise<string>; llm: Llm; botMemberships: () => Promise<string[]>; threshold: number; recentK: number; foldWindow: number; maxFolds: number; now: () => string }): Promise<{ folded: number; skipped: number; deferred: number }>` — reconciles, batch-reads profiles once, and for each ripe channel folds the oldest `foldWindow` messages (up to `maxFolds` folds/tick), writing only folded profiles.

- [ ] **Step 1: Add `allProfiles` to the Ledger (batch read)**

In `test/slack/ledger.test.ts`, add a test inside the `describe`:

```typescript
  it("allProfiles returns the latest profile per entity", async () => {
    const { client } = fakeClient();
    const ledger = makeLedger(client, "CLEDGER");
    await ledger.writeProfile(profile("channel:C1", "old"));
    await ledger.writeProfile(profile("channel:C1", "new"));
    await ledger.writeProfile(profile("channel:C2", "two"));
    const all = await ledger.allProfiles();
    expect(all.map((p) => [p.entityId, p.static.summary]).sort())
      .toEqual([["channel:C1", "new"], ["channel:C2", "two"]]);
  });
```

Run: `npx vitest run test/slack/ledger.test.ts` → FAIL (`allProfiles` undefined).

Add `allProfiles` to the `Ledger` interface in `src/slack/ledger.ts`:

```typescript
  allProfiles(): Promise<EntityProfile[]>;
```

And implement it in the returned object (next to `allDecisions`), importing `isEntityProfile` (already imported):

```typescript
    async allProfiles() {
      const seen = new Set<string>();
      const out: EntityProfile[] = [];
      for (const r of await readAll()) { // newest-first => first per entity is latest
        if (isEntityProfile(r) && !seen.has(r.entityId)) { seen.add(r.entityId); out.push(r); }
      }
      return out;
    },
```

Run: `npx vitest run test/slack/ledger.test.ts` → PASS.

- [ ] **Step 2: Write the failing loop test**

```typescript
// test/observer/loop.test.ts
import { describe, it, expect, vi } from "vitest";
import { runObserverTick } from "../../src/observer/loop";
import { makeLedger } from "../../src/slack/ledger";
import { makeRegistry } from "../../src/slack/registry";
import { makeHistory } from "../../src/slack/history";
import { Llm } from "../../src/agent/llm";

function fakeLedgerClient() {
  const messages: any[] = [];
  return {
    client: {
      async chatPostMessage(a: any) { messages.unshift({ metadata: a.metadata }); },
      async conversationsHistory() { return { messages }; },
    } as any,
    messages,
  };
}
function foldLlm() {
  const create = vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify({
    static: { summary: "warmed", keyPeople: [], keySystems: [], decisionNorms: "", builtAt: "t" },
    dynamic: { inFlightDecisions: [], recentThreads: [], openQuestions: [], searchCursor: { untilTs: "z" }, refreshedAt: "z" },
  })}]}));
  return { llm: new Llm({ messages: { create } } as any), create };
}
function fakeHistoryClient(byChannel: Record<string, { ts: string; user?: string; text?: string }[]>) {
  return { conversationsHistory: vi.fn(async (a: any) => ({
    messages: (byChannel[a.channel] ?? [])
      .filter((m) => !a.oldest || Number(m.ts) > Number(a.oldest))
      .sort((x, y) => Number(y.ts) - Number(x.ts)),
  })) };
}
const deps = (over: any) => ({
  permalink: async (c: string, ts: string) => `https://x/${c}/${ts}`,
  threshold: 8, recentK: 3, foldWindow: 50, maxFolds: 10, now: () => "t", ...over,
});

describe("runObserverTick", () => {
  it("folds a ripe channel and writes a warmed profile with the newest cursor", async () => {
    const { client } = fakeLedgerClient();
    const ledger = makeLedger(client, "CLEDGER");
    const registry = makeRegistry(client, "CLEDGER", () => "t");
    const history = makeHistory(fakeHistoryClient({
      C1: Array.from({ length: 10 }, (_, i) => ({ ts: `${200 + i}`, user: "U1", text: "postgres talk" })),
    }));
    const { llm, create } = foldLlm();

    const res = await runObserverTick(deps({ ledger, registry, history, llm, botMemberships: async () => ["C1"] }));

    expect(res.folded).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    const profile = await ledger.getProfile("channel:C1");
    expect(profile?.static.summary).toBe("warmed");
    expect(profile?.dynamic.searchCursor.untilTs).toBe("209");
    expect(profile?.dynamic.recentThreads).toHaveLength(3);
  });

  it("does NOT fold or write a channel below threshold that has been folded before", async () => {
    const { client } = fakeLedgerClient();
    const ledger = makeLedger(client, "CLEDGER");
    const registry = makeRegistry(client, "CLEDGER", () => "t");
    // Seed an already-folded profile (non-empty summary) at cursor 200.
    await ledger.writeProfile({
      recordType: "entity_profile", entityId: "channel:C1",
      static: { summary: "already", keyPeople: [], keySystems: [], decisionNorms: "", builtAt: "t" },
      dynamic: { inFlightDecisions: [], recentThreads: [], openQuestions: [], searchCursor: { untilTs: "200" }, refreshedAt: "t" },
    });
    const history = makeHistory(fakeHistoryClient({ C1: [{ ts: "205", user: "U1", text: "one new" }] })); // 1 < threshold
    const { llm, create } = foldLlm();

    const res = await runObserverTick(deps({ ledger, registry, history, llm, botMemberships: async () => ["C1"] }));

    expect(res.skipped).toBe(1);
    expect(res.folded).toBe(0);
    expect(create).not.toHaveBeenCalled();
    // cursor unchanged — the un-folded message is still searchable by a later capture
    expect((await ledger.getProfile("channel:C1"))?.dynamic.searchCursor.untilTs).toBe("200");
  });

  it("honors the per-tick fold cap, deferring the rest", async () => {
    const { client } = fakeLedgerClient();
    const ledger = makeLedger(client, "CLEDGER");
    const registry = makeRegistry(client, "CLEDGER", () => "t");
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ts: `${100 + i}`, user: "U1", text: "x" }));
    const history = makeHistory(fakeHistoryClient({ C1: many(10), C2: many(10), C3: many(10) }));
    const { llm, create } = foldLlm();

    const res = await runObserverTick(deps({
      ledger, registry, history, llm, maxFolds: 2, botMemberships: async () => ["C1", "C2", "C3"] }));

    expect(res.folded).toBe(2);
    expect(res.deferred).toBe(1);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("folds oldest-first within the window, never advancing the cursor past un-folded messages", async () => {
    const { client } = fakeLedgerClient();
    const ledger = makeLedger(client, "CLEDGER");
    const registry = makeRegistry(client, "CLEDGER", () => "t");
    const history = makeHistory(fakeHistoryClient({
      C1: [101, 102, 103, 104, 105].map((n) => ({ ts: `${n}`, user: "U1", text: "x" })),
    }));
    const { llm, create } = foldLlm();

    // Cold channel (cursor "0") is ripe; foldWindow 2 => fold ONLY the oldest 2 (101,102).
    const res = await runObserverTick(deps({
      ledger, registry, history, llm, threshold: 2, foldWindow: 2, botMemberships: async () => ["C1"] }));

    expect(res.folded).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    // Cursor advances to the newest FOLDED message (102), NOT the global newest (105):
    // messages 103–105 stay behind an un-advanced cursor, still live-searchable by a capture.
    expect((await ledger.getProfile("channel:C1"))?.dynamic.searchCursor.untilTs).toBe("102");
  });
});
```

- [ ] **Step 3: Run it to confirm failure**

Run: `npx vitest run test/observer/loop.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/observer/loop.ts`**

```typescript
// src/observer/loop.ts
import type { Ledger } from "../slack/ledger.js";
import { reconcileRegistry, type Registry } from "../slack/registry.js";
import type { HistoryReader } from "../slack/history.js";
import type { Llm } from "../agent/llm.js";
import { coldProfile, isRipe, observeActivity } from "../memory/observer.js";
import { entityIdForChannel, type EntityProfile } from "../types.js";

const numTs = (ts: string): number => Number(ts) || 0;

export async function runObserverTick(deps: {
  ledger: Ledger;
  registry: Registry;
  history: HistoryReader;
  permalink: (channelId: string, ts: string) => Promise<string>;
  llm: Llm;
  botMemberships: () => Promise<string[]>;
  threshold: number;
  recentK: number;
  foldWindow: number;
  maxFolds: number;
  now: () => string;
}): Promise<{ folded: number; skipped: number; deferred: number }> {
  const { active } = await reconcileRegistry(deps.registry, await deps.botMemberships());

  // One batch read of all profiles per tick (avoids a full ledger scan per channel).
  const byEntity = new Map<string, EntityProfile>();
  for (const p of await deps.ledger.allProfiles()) byEntity.set(p.entityId, p);

  let folded = 0, skipped = 0, deferred = 0;
  for (const channelId of active) {
    const entityId = entityIdForChannel(channelId);
    const prior = byEntity.get(entityId) ?? coldProfile(entityId, deps.now());
    const backlog = await deps.history.readSince(channelId, prior.dynamic.searchCursor.untilTs);

    if (backlog.length === 0 || !isRipe(prior, backlog.length, deps.threshold)) { skipped++; continue; }
    if (folded >= deps.maxFolds) { deferred++; continue; } // per-tick Opus ceiling; backlog waits for next tick

    // Fold OLDEST-first in a bounded window so coverage stays contiguous from the cursor:
    // the cursor advances only to the newest message we actually fold, never past the tail.
    // A backlog larger than the window drains over successive ticks; a capture live-searches
    // whatever isn't folded yet, so warm ≤ cold holds even on a huge cold-start backlog.
    const oldestFirst = [...backlog].sort((x, y) => numTs(x.ts) - numTs(y.ts));
    const window = oldestFirst.slice(0, Math.max(1, deps.foldWindow)).reverse(); // newest-first; clamp guards a misconfigured foldWindow<=0

    const recentRefs = await Promise.all(window.slice(0, deps.recentK).map(async (m) => ({
      permalink: await deps.permalink(channelId, m.ts),
      snippet: m.text.slice(0, 160),
      ts: m.ts,
    })));

    const profile = await observeActivity({ llm: deps.llm, prior, messages: window, recentRefs, now: deps.now() });
    await deps.ledger.writeProfile(profile);
    folded++;
  }
  return { folded, skipped, deferred };
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npx vitest run test/observer/loop.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/slack/ledger.ts test/slack/ledger.test.ts src/observer/loop.ts test/observer/loop.test.ts
git commit -m "feat: runObserverTick — reconcile, batch profiles, ripe-fold with per-tick cap"
```

---

### Task 5: Config + app scheduler wiring

**Files:**
- Modify: `src/config.ts`, `test/config.test.ts`, `.env.example`
- Modify: `src/app.ts` (gate: `tsc --noEmit` + live; not unit-tested)

**Interfaces:**
- Produces: five new `Config` fields — `observerEnabled: boolean`, `observerIntervalMs: number` (default 300000), `observerThreshold: number` (default 8), `observerRecentK: number` (default 3), `observerMaxFoldsPerTick: number` (default 3).

- [ ] **Step 1: Write the failing config test**

Append inside the `describe` in `test/config.test.ts`:

```typescript
  it("defaults observer settings when unset and parses overrides", () => {
    const base = {
      SLACK_BOT_TOKEN: "b", SLACK_APP_TOKEN: "a", SLACK_SIGNING_SECRET: "s",
      SLACK_WORKSPACE_TOKEN: "w", LEDGER_CHANNEL_ID: "C", ANTHROPIC_API_KEY: "k",
    };
    const def = loadConfig({ ...base } as any);
    expect(def.observerEnabled).toBe(false);
    expect(def.observerIntervalMs).toBe(300000);
    expect(def.observerThreshold).toBe(8);
    expect(def.observerFoldWindow).toBe(50);
    expect(def.observerMaxFoldsPerTick).toBe(3);
    const over = loadConfig({ ...base, OBSERVER_ENABLED: "true", OBSERVER_CONSOLIDATE_THRESHOLD: "5", OBSERVER_MAX_FOLDS_PER_TICK: "1" } as any);
    expect(over.observerEnabled).toBe(true);
    expect(over.observerThreshold).toBe(5);
    expect(over.observerMaxFoldsPerTick).toBe(1);
  });
```

Run: `npx vitest run test/config.test.ts` → FAIL (`observerEnabled` undefined).

- [ ] **Step 2: Implement the config additions in `src/config.ts`**

Extend the `Config` interface:

```typescript
export interface Config {
  botToken: string; appToken: string; signingSecret: string;
  workspaceToken: string; ledgerChannelId: string; anthropicKey: string;
  observerEnabled: boolean;
  observerIntervalMs: number;
  observerThreshold: number;
  observerRecentK: number;
  observerFoldWindow: number;
  observerMaxFoldsPerTick: number;
}
```

Add before `return cfg as Config;`:

```typescript
  cfg.observerEnabled = env.OBSERVER_ENABLED === "true";
  cfg.observerIntervalMs = Number(env.OBSERVER_INTERVAL_MS ?? "300000");
  cfg.observerThreshold = Number(env.OBSERVER_CONSOLIDATE_THRESHOLD ?? "8");
  cfg.observerRecentK = Number(env.OBSERVER_RECENT_K ?? "3");
  cfg.observerFoldWindow = Number(env.OBSERVER_FOLD_WINDOW ?? "50");
  cfg.observerMaxFoldsPerTick = Number(env.OBSERVER_MAX_FOLDS_PER_TICK ?? "3");
```

Run: `npx vitest run test/config.test.ts` → PASS (3 tests).

- [ ] **Step 3: Add the observer env vars to `.env.example`**

Append:

```bash
# Async observer (optional; off unless OBSERVER_ENABLED=true)
OBSERVER_ENABLED=false
OBSERVER_INTERVAL_MS=300000
OBSERVER_CONSOLIDATE_THRESHOLD=8
OBSERVER_RECENT_K=3
OBSERVER_FOLD_WINDOW=50
OBSERVER_MAX_FOLDS_PER_TICK=3
```

- [ ] **Step 4: Wire the scheduler in `src/app.ts`**

Add imports near the other `./slack` imports:

```typescript
import { makeRegistry } from "./slack/registry.js";
import { makeHistory } from "./slack/history.js";
import { runObserverTick } from "./observer/loop.js";
```

Replace the final `await app.start();` + `console.log(...)` lines with:

```typescript
await app.start();
console.log("⚡ DecisionOps agent running (socket mode)");

if (cfg.observerEnabled) {
  const registry = makeRegistry(ledgerClient, cfg.ledgerChannelId, nowIso);
  const history = makeHistory({ conversationsHistory: (a) => bot.conversations.history(a as any) as any });
  const botMemberships = async (): Promise<string[]> => {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const res: any = await bot.users.conversations({
        types: "public_channel,private_channel", exclude_archived: true, limit: 200, cursor,
      });
      for (const c of res.channels ?? []) if (c.id) ids.push(c.id);
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return ids;
  };
  const permalink = async (channel: string, ts: string): Promise<string> => {
    const res: any = await bot.chat.getPermalink({ channel, message_ts: ts });
    return res.permalink ?? `slack://channel?id=${channel}&ts=${ts}`;
  };

  let running = false; // overlapping-tick guard (app-level; gated by tsc + live, not unit-tested)
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runObserverTick({
        ledger, registry, history, permalink, llm, botMemberships,
        threshold: cfg.observerThreshold, recentK: cfg.observerRecentK,
        foldWindow: cfg.observerFoldWindow, maxFolds: cfg.observerMaxFoldsPerTick, now: nowIso,
      });
      console.log(`observer tick: folded=${r.folded} skipped=${r.skipped} deferred=${r.deferred}`);
    } catch (e) {
      console.error("observer tick failed:", e);
    } finally {
      running = false;
    }
  };
  setInterval(tick, cfg.observerIntervalMs);
  console.log(`👀 observer enabled — every ${cfg.observerIntervalMs}ms, ≤${cfg.observerMaxFoldsPerTick} folds/tick`);
}
```

- [ ] **Step 5: Typecheck (the gate for `app.ts`) and run the full suite**

Run: `npx tsc -p tsconfig.json --noEmit && npm test`
Expected: tsc clean; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.ts src/app.ts .env.example
git commit -m "feat: wire async observer scheduler (guarded, opt-in, per-tick fold cap)"
```

---

### Task 6: Eval — the observer *causally* warms a capture

**Files:**
- Modify: `eval/fakeSlack.ts`
- Modify: `eval/harness.test.ts`

The search-count reduction must be *caused* by the observer-written profile, not by two different scripts. So the same profile-aware capture LLM is used for both the cold and observed captures; its gap-check loop searches only while the injected profile does **not** already cover the area. Cold → no observer summary in the profile → it searches. Observed → the observer wrote `static.summary` → the loop sees it and stops. The delta is causal.

**Interfaces:**
- Consumes: `makeRegistry`, `makeHistory`, `runObserverTick`, existing `makeLedger`/`makeSearch`/`runCapture`/`SearchBudget`.
- Produces: fake extensions — `historyClient`, `seedChannel`, `setMemberships`, `memberships`, `permalink`.

- [ ] **Step 1: Extend `eval/fakeSlack.ts`**

Replace the file with:

```typescript
// eval/fakeSlack.ts
import type { LedgerClient } from "../src/slack/ledger.js";
import type { RtsClient } from "../src/rts/search.js";
import type { HistoryClient } from "../src/slack/history.js";

export function makeFakeSlack() {
  const messages: any[] = [];
  let calls = 0;
  let result = [{ permalink: "p", channel_id: "C1", ts: "1.0", text: "ctx", is_private: false }];
  const channels: Record<string, { ts: string; user?: string; text?: string }[]> = {};
  let members: string[] = [];

  const ledgerClient: LedgerClient = {
    async chatPostMessage(a) { messages.unshift({ metadata: a.metadata }); },
    async conversationsHistory() { return { messages }; },
  };
  const rts: RtsClient = {
    async searchContext() { calls++; return { results: { messages: result } }; },
    async searchInfo() { return { semantic_search_enabled: false }; },
  };
  const historyClient: HistoryClient = {
    async conversationsHistory(a) {
      const msgs = (channels[a.channel] ?? [])
        .filter((m) => !a.oldest || Number(m.ts) > Number(a.oldest))
        .sort((x, y) => Number(y.ts) - Number(x.ts));
      return { messages: msgs };
    },
  };
  return {
    ledgerClient, rts, historyClient,
    searchCalls: () => calls,
    seedSearchResult(r: typeof result) { result = r; },
    seedChannel(id: string, msgs: { ts: string; user?: string; text?: string }[]) { channels[id] = msgs; },
    setMemberships(ids: string[]) { members = ids; },
    memberships: () => members,
    permalink: async (channelId: string, ts: string) => `https://x/${channelId}/${ts}`,
    raw: messages,
  };
}
```

- [ ] **Step 2: Add the causal eval to `eval/harness.test.ts`**

Extend the imports:

```typescript
import { makeRegistry } from "../src/slack/registry";
import { makeHistory } from "../src/slack/history";
import { runObserverTick } from "../src/observer/loop";
```

Add these two helpers below `scriptedLlm`:

```typescript
// Observer fold LLM — writes a recognizable summary into static.
function warmingLlm() {
  const create = vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify({
    static: { summary: "billing migration workstream", keyPeople: ["U1"], keySystems: ["pg"], decisionNorms: "", builtAt: "t" },
    dynamic: { inFlightDecisions: [], recentThreads: [], openQuestions: [], searchCursor: { untilTs: "z" }, refreshedAt: "z" },
  })}]}));
  return new Llm({ messages: { create } } as any);
}
// Capture LLM whose gap-check loop searches ONLY while the injected profile does not
// already cover the area — so search count depends causally on the observer's writes.
function profileAwareCaptureLlm() {
  let phase = 0;
  const create = vi.fn(async (req: any) => {
    if (req.output_config?.format) {
      phase++;
      if (phase === 1) return { content: [{ type: "text", text: JSON.stringify({
        decisionStatement: "Adopt Postgres", options: ["pg"], entities: ["channel:C1"],
        openQuestions: ["prior decisions?", "owners?", "constraints?"], title: "DB" })}]};
      return { content: [{ type: "text", text: JSON.stringify({
        title: "DB", decisionText: "pg", optionsConsidered: ["pg"], rationale: "r",
        proposedOwners: [], openQuestions: [], bodySummary: "b" })}]};
    }
    const injected = JSON.stringify(req.system ?? "") + JSON.stringify(req.messages ?? "");
    const covered = injected.includes("billing migration workstream"); // observer-written summary
    if (!covered) return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "search", input: { query: "q" } }] };
    return { stop_reason: "end_turn", content: [{ type: "text", text: "profile already covers it" }] };
  });
  return new Llm({ messages: { create } } as any);
}
```

Add the test inside the `describe`:

```typescript
  it("(e) an observer fold causally warms a channel's next capture (fewer RTS calls)", async () => {
    // COLD — capture on a channel the observer never touched; same capture LLM as warm.
    const cold = makeFakeSlack();
    const coldLedger = makeLedger(cold.ledgerClient, "CLEDGER");
    const coldBudget = new SearchBudget(6);
    const coldRes = await runCapture(
      { ledger: coldLedger, llm: profileAwareCaptureLlm(), search: makeSearch(cold.rts, coldBudget), budget: coldBudget, now: "t" },
      { channelId: "C1", threadTs: "1.0", capturer: "U1", threadText: "..." });

    // OBSERVED — register C1, seed activity, run ONE observer tick to fold a profile.
    const obs = makeFakeSlack();
    obs.setMemberships(["C1"]);
    obs.seedChannel("C1", Array.from({ length: 10 }, (_, i) => ({ ts: `${100 + i}`, user: "U1", text: "postgres migration" })));
    const ledger = makeLedger(obs.ledgerClient, "CLEDGER");
    const registry = makeRegistry(obs.ledgerClient, "CLEDGER", () => "t");
    const history = makeHistory(obs.historyClient);
    await runObserverTick({
      ledger, registry, history, llm: warmingLlm(), permalink: obs.permalink,
      botMemberships: async () => obs.memberships(), threshold: 8, recentK: 3, foldWindow: 50, maxFolds: 3, now: () => "t" });

    // The observer folded raw activity into a warm profile (cursor advanced over folded content).
    const warmed = await ledger.getProfile("channel:C1");
    expect(warmed?.dynamic.searchCursor.untilTs).toBe("109");
    expect(warmed?.static.summary).toBe("billing migration workstream");

    // Same capture LLM — now it sees the observer's summary and stops searching.
    const capBudget = new SearchBudget(6);
    const warmRes = await runCapture(
      { ledger, llm: profileAwareCaptureLlm(), search: makeSearch(obs.rts, capBudget), budget: capBudget, now: "t" },
      { channelId: "C1", threadTs: "2.0", capturer: "U1", threadText: "..." });

    expect(coldRes.rtsCalls).toBeGreaterThan(0);
    expect(warmRes.rtsCalls).toBe(0);
    expect(warmRes.rtsCalls).toBeLessThan(coldRes.rtsCalls);
    console.log(`cold RTS calls=${coldRes.rtsCalls}  observed RTS calls=${warmRes.rtsCalls}`); // thesis, extended + causal
  });
```

- [ ] **Step 3: Run the eval**

Run: `npx vitest run eval/harness.test.ts`
Expected: PASS (existing 4 + 1 new = 5). Console prints `cold RTS calls=5  observed RTS calls=0` (cold count = the gap-check tool loop's iterations before its tool-free finalizer).

- [ ] **Step 4: Full suite + typecheck**

Run: `npm test && npx tsc -p tsconfig.json --noEmit`
Expected: all green; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add eval/fakeSlack.ts eval/harness.test.ts
git commit -m "test: eval proves the observer CAUSALLY warms a capture (profile-driven search count)"
```

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- §2 registry-from-membership → Task 1. Cursor invariant (§2/§6) → Task 3 (`isRipe` gate keyed on `cursor==="0"` + fold-only advance) + Task 4 loop (**oldest-first `foldWindow`**); the "below threshold → no write/no advance" case is pinned by Task 4's second test, and the "cursor never jumps past un-folded messages on a >window backlog" case by Task 4's fourth test. ✓
- §3/§4 components → Tasks 1–5. ✓
- §5 per-tick flow (reconcile → batch profiles → ripe-fold, capped) → Task 4. ✓
- §6 cursor model: monotonic + verbatim ts → Task 3 (`reduce` seeded with prior, no `Number` round-trip), pinned by the "never backward" + "verbatim" tests. ✓
- §7 cost/safety: per-tick fold cap → Tasks 4/5; provenance ≤160 same-channel-only → Task 4 + Global Constraints. ✓
- §7 permission/laundering: recentThreads documented bot-visible/same-channel-only (no false scope.ts claim) → Global Constraints + spec §7. ✓
- §8 interfaces → match Tasks 1–4 verbatim. ✓
- §9 testing incl. causal eval → Tasks 1–4 tests + Task 6. ✓
- §10 risks (cold-start full read, ledger compaction) → Task 2 note + spec §10. ✓

**2. Placeholder scan** — no TBD/TODO; every code step has complete code; every run step has an exact command + expected result. ✓

**3. Type consistency** — `ChannelMessage`/`ChannelRegistration`/`RecentThread` defined in Task 1, imported unchanged in Tasks 2–4; `isRipe` + `observeActivity` signatures in Task 3 match their calls in Task 4; `observeActivity` always returns `EntityProfile` (fold), gated by `isRipe` in the loop — no stale `usedLlm` flag; `reconcileRegistry` returns `{added,removed,active}` (Task 1) and Task 4 destructures `active`; `Ledger.allProfiles` added in Task 4 Step 1 and used immediately after; `runObserverTick` returns `{folded,skipped,deferred}` consistently. ✓

**Note on `app.ts`:** not unit-tested (project convention); gate is `tsc --noEmit` (Task 5 Step 5) + a live run. All testable logic lives in `runObserverTick` (Task 4); `app.ts` holds only the guard + membership pagination + permalink glue.

---

## Execution Handoff

After approval, two execution options:
1. **Subagent-Driven (recommended)** — a fresh subagent per task with two-stage review between tasks (`superpowers:subagent-driven-development`).
2. **Inline Execution** — batch execution with checkpoints (`superpowers:executing-plans`).
