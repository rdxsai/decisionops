# DecisionOps Agent v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v1 "capture-flow" DecisionOps agent — a Slack message shortcut that turns a thread into a context-grounded decision brief in a Canvas, routes a Block Kit approval, posts the final decision with owners, and remembers what it learned in a Slack-native Ledger so the next capture in that area is cheaper.

**Architecture:** A self-hosted Bolt (TypeScript) app. **All persistence is Slack message metadata** in a single private "Ledger" channel (no external DB). The agent loop is owned directly via the Anthropic Messages API: the entity's **static profile** rides in a prompt-cached `system` block, the **dynamic profile** is injected per turn as an Opus 4.8 mid-conversation system message, and retrieval is a **bounded (≤6-call) manual tool loop** over Real-Time Search (RTS). An inline "observer" consolidates decisions + the RTS delta back into profiles after each capture.

**Tech Stack:** TypeScript, `@slack/bolt` + `@slack/web-api`, `@anthropic-ai/sdk` (model `claude-opus-4-8`), Vitest for tests, `tsx` for local run.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-06-28-decisionops-design.md`. Every task implicitly includes these.

- **App type:** internal / custom Slack app, single workspace. Do not distribute (the 2025 `conversations.history` throttle exempts internal apps only).
- **Persistence:** Slack message metadata is the *only* datastore. No DB, vector store, object store, or local file persistence for agent state. The Ledger is one dedicated private channel; records are append-only, latest-wins on read.
- **Model:** `claude-opus-4-8`, `thinking: {type: "adaptive"}`, `output_config: {effort: "high"}`. Never a date-suffixed model ID.
- **Retrieval:** RTS `assistant.search.context`, **user-scoped** (search as the invoking user). **Keyword-first**; enable semantic only when `assistant.search.info` reports Slack AI Search available. **Hard budget ≤6 RTS calls per capture.** Delta-scope every live search with `after` = the entity's `dynamic.searchCursor.untilTs`.
- **RTS token:** call `assistant.search.context` with a **workspace-level** token (org/Grid tokens return `enterprise_is_restricted`).
- **History reads:** `conversations.history` / `conversations.replies` with `include_all_metadata: true`.
- **Canvas is write-only** from our side (no Web API read-back). Authoritative state lives in metadata; the Canvas is rendered from it.
- **Approval card** is posted with `chat.postMessage` (interactive blocks cannot attach mid-`chat.stopStream`).
- **Permissions:** store **provenance, not payload** — Ledger and brief hold permalinks + minimal snippets and link to sources; inline only content at least as open as the brief's audience; the Ledger channel's membership is an access-control boundary.
- **Prompt caching:** static profile is bundled with system instructions under one `cache_control` breakpoint (the profile alone is below Opus 4.8's 4096-token cache floor). Dynamic profile is injected as a `role:"system"` message in `messages[]`, never by editing top-level `system`.

## File Structure

```
slack-agent/
  package.json, tsconfig.json, vitest.config.ts, .env.example
  src/
    config.ts            # env + token selection (bot/user/workspace)
    types.ts             # shared domain types (single source of truth)
    slack/
      ledger.ts          # read/write decision_record + entity_profile via metadata
      thread.ts          # conversations.replies hydration
      canvas.ts          # canvases.create / canvases.edit (brief rendering)
      blocks.ts          # Block Kit builders (brief msg, approval card, final)
    rts/
      search.ts          # assistant.search.context wrapper + semantic detect
      budget.ts          # ≤6-call budget guard
    memory/
      entities.ts        # entity extraction (LLM) + entity-id helpers
      observer.ts        # inline consolidation -> static/dynamic profiles
    agent/
      llm.ts             # Anthropic client: cached system, mid-conv system, bounded tool loop, structured
      resolve.ts         # step 3: thread -> decision statement / options / entities / open Qs
      gapcheck.ts        # steps 5-6: bounded RTS tool loop
      synthesize.ts      # step 7: thread + gaps -> brief + body
      capture.ts         # orchestrates steps 1-10
    permissions/
      scope.ts           # provenance redaction + audience scoping
    app.ts               # Bolt wiring: shortcut + action handlers + finalize
  test/                  # mirrors src/ (Vitest)
  eval/
    fakeSlack.ts         # in-memory Slack fake (metadata round-trip, search)
    harness.test.ts      # logic-layer eval + cold-vs-warm RTS count
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`
- Create: `src/types.ts`
- Test: `test/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every domain type used by later tasks. Exact names below — later tasks import from `../src/types`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "decisionops-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "dev": "tsx watch src/app.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0",
    "@slack/bolt": "^4.2.0",
    "@slack/web-api": "^7.8.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "test", "eval"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { globals: true, environment: "node" } });
```

- [ ] **Step 4: Create `.env.example`**

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...            # socket mode
SLACK_SIGNING_SECRET=...
SLACK_WORKSPACE_TOKEN=xoxp-...      # user/workspace token for RTS (search as user)
LEDGER_CHANNEL_ID=C...              # the private Ledger channel
ANTHROPIC_API_KEY=sk-ant-...
```

- [ ] **Step 5: Write the failing test for types**

```typescript
// test/types.test.ts
import { describe, it, expect } from "vitest";
import { entityIdForChannel, isDecisionRecord } from "../src/types";

describe("types helpers", () => {
  it("builds a channel entity id", () => {
    expect(entityIdForChannel("C123")).toBe("channel:C123");
  });
  it("type-guards a decision record", () => {
    const rec = { recordType: "decision_record", id: "d1" };
    expect(isDecisionRecord(rec)).toBe(true);
    expect(isDecisionRecord({ recordType: "entity_profile" })).toBe(false);
  });
});
```

- [ ] **Step 6: Run it to confirm failure**

Run: `npm install && npx vitest run test/types.test.ts`
Expected: FAIL — `Cannot find module '../src/types'`.

- [ ] **Step 7: Write `src/types.ts`**

```typescript
// src/types.ts
export type EntityId = string; // "channel:C123" | "project:atlas" | "user:U123"

export const entityIdForChannel = (channelId: string): EntityId => `channel:${channelId}`;
export const entityIdForUser = (userId: string): EntityId => `user:${userId}`;
export const entityIdForProject = (slug: string): EntityId => `project:${slug}`;

export type Visibility = "public" | "private" | "dm";

export interface ContextRef {
  permalink: string;
  channelId: string;
  ts: string;
  snippet: string;       // minimal; never a full message body
  visibility: Visibility;
}

export interface Owner {
  userId: string;
  task: string;
  due?: string; // ISO date
}

export type DecisionStatus = "draft" | "in_review" | "decided" | "rejected";

export interface DecisionRecord {
  recordType: "decision_record";
  id: string;
  title: string;
  status: DecisionStatus;
  origin: { channelId: string; threadTs: string };
  capturer: string;
  approvers: string[];
  decidedAt?: string;
  decisionText: string;
  optionsConsidered: string[];
  rationale: string;
  owners: Owner[];
  entities: EntityId[];
  relatedDecisionIds: string[];
  contextRefs: ContextRef[];
  canvasId?: string;
}

export interface StaticProfile {
  summary: string;
  keyPeople: string[];
  keySystems: string[];
  decisionNorms: string;
  builtAt: string;
}

export interface DynamicProfile {
  inFlightDecisions: string[];
  recentThreads: { permalink: string; snippet: string; ts: string }[];
  openQuestions: string[];
  searchCursor: { untilTs: string };
  refreshedAt: string;
}

export interface EntityProfile {
  recordType: "entity_profile";
  entityId: EntityId;
  static: StaticProfile;
  dynamic: DynamicProfile;
}

export type LedgerRecord = DecisionRecord | EntityProfile;

export const isDecisionRecord = (r: any): r is DecisionRecord =>
  r?.recordType === "decision_record";
export const isEntityProfile = (r: any): r is EntityProfile =>
  r?.recordType === "entity_profile";

export const DECISION_EVENT_TYPE = "decisionops_record";
export const PROFILE_EVENT_TYPE = "decisionops_profile";
```

- [ ] **Step 8: Run the test to confirm it passes**

Run: `npx vitest run test/types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .env.example src/types.ts test/types.test.ts
git commit -m "feat: scaffold project and domain types"
```

---

### Task 2: Ledger — Slack-native state via message metadata

**Files:**
- Create: `src/slack/ledger.ts`
- Test: `test/slack/ledger.test.ts`

**Interfaces:**
- Consumes: `DecisionRecord`, `EntityProfile`, `EntityId`, `DECISION_EVENT_TYPE`, `PROFILE_EVENT_TYPE` from `../types`.
- Produces:
  - `interface LedgerClient` — the minimal Slack surface the Ledger needs (so tests can fake it):
    `chatPostMessage(args: { channel: string; text: string; metadata: { event_type: string; event_payload: Record<string, any> } }): Promise<void>`
    `conversationsHistory(args: { channel: string; include_all_metadata: true; cursor?: string }): Promise<{ messages: Array<{ metadata?: { event_type: string; event_payload: any } }>; response_metadata?: { next_cursor?: string } }>`
  - `makeLedger(client: LedgerClient, channelId: string): Ledger`
  - `interface Ledger { writeDecision(r: DecisionRecord): Promise<void>; writeProfile(p: EntityProfile): Promise<void>; getProfile(id: EntityId): Promise<EntityProfile | null>; relatedDecisions(entities: EntityId[]): Promise<DecisionRecord[]>; allDecisions(): Promise<DecisionRecord[]>; }`

- [ ] **Step 1: Write the failing test**

```typescript
// test/slack/ledger.test.ts
import { describe, it, expect } from "vitest";
import { makeLedger, type LedgerClient } from "../../src/slack/ledger";
import { DECISION_EVENT_TYPE, PROFILE_EVENT_TYPE, type DecisionRecord, type EntityProfile } from "../../src/types";

function fakeClient() {
  const messages: any[] = [];
  const client: LedgerClient = {
    async chatPostMessage(args) {
      // newest-first like Slack: unshift
      messages.unshift({ metadata: args.metadata });
    },
    async conversationsHistory() {
      return { messages };
    },
  };
  return { client, messages };
}

const decision = (id: string, entities: string[]): DecisionRecord => ({
  recordType: "decision_record", id, title: id, status: "decided",
  origin: { channelId: "C1", threadTs: "1.0" }, capturer: "U1", approvers: [],
  decisionText: "x", optionsConsidered: [], rationale: "y", owners: [],
  entities, relatedDecisionIds: [], contextRefs: [],
});

const profile = (entityId: string, summary: string): EntityProfile => ({
  recordType: "entity_profile", entityId,
  static: { summary, keyPeople: [], keySystems: [], decisionNorms: "", builtAt: "t" },
  dynamic: { inFlightDecisions: [], recentThreads: [], openQuestions: [], searchCursor: { untilTs: "0" }, refreshedAt: "t" },
});

describe("Ledger", () => {
  it("writes and reads back a decision via metadata", async () => {
    const { client } = fakeClient();
    const ledger = makeLedger(client, "CLEDGER");
    await ledger.writeDecision(decision("d1", ["channel:C1"]));
    const all = await ledger.allDecisions();
    expect(all.map((d) => d.id)).toEqual(["d1"]);
  });

  it("returns latest profile (latest-wins on append)", async () => {
    const { client } = fakeClient();
    const ledger = makeLedger(client, "CLEDGER");
    await ledger.writeProfile(profile("channel:C1", "old"));
    await ledger.writeProfile(profile("channel:C1", "new"));
    const p = await ledger.getProfile("channel:C1");
    expect(p?.static.summary).toBe("new");
  });

  it("finds related decisions by shared entity, newest-first, deduped", async () => {
    const { client } = fakeClient();
    const ledger = makeLedger(client, "CLEDGER");
    await ledger.writeDecision(decision("d1", ["channel:C1", "project:atlas"]));
    await ledger.writeDecision(decision("d2", ["channel:C9"]));
    await ledger.writeDecision(decision("d3", ["project:atlas"]));
    const related = await ledger.relatedDecisions(["project:atlas"]);
    expect(related.map((d) => d.id)).toEqual(["d3", "d1"]);
  });

  it("tags the right event_type on writes", async () => {
    const { client, messages } = fakeClient();
    const ledger = makeLedger(client, "CLEDGER");
    await ledger.writeDecision(decision("d1", []));
    await ledger.writeProfile(profile("channel:C1", "s"));
    expect(messages.map((m) => m.metadata.event_type).sort())
      .toEqual([DECISION_EVENT_TYPE, PROFILE_EVENT_TYPE].sort());
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run test/slack/ledger.test.ts`
Expected: FAIL — `Cannot find module '../../src/slack/ledger'`.

- [ ] **Step 3: Implement `src/slack/ledger.ts`**

```typescript
// src/slack/ledger.ts
import {
  DECISION_EVENT_TYPE, PROFILE_EVENT_TYPE,
  isDecisionRecord, isEntityProfile,
  type DecisionRecord, type EntityProfile, type EntityId,
} from "../types.js";

export interface LedgerClient {
  chatPostMessage(args: {
    channel: string;
    text: string;
    metadata: { event_type: string; event_payload: Record<string, any> };
  }): Promise<void>;
  conversationsHistory(args: {
    channel: string;
    include_all_metadata: true;
    cursor?: string;
  }): Promise<{
    messages: Array<{ metadata?: { event_type: string; event_payload: any } }>;
    response_metadata?: { next_cursor?: string };
  }>;
}

export interface Ledger {
  writeDecision(r: DecisionRecord): Promise<void>;
  writeProfile(p: EntityProfile): Promise<void>;
  getProfile(id: EntityId): Promise<EntityProfile | null>;
  relatedDecisions(entities: EntityId[]): Promise<DecisionRecord[]>;
  allDecisions(): Promise<DecisionRecord[]>;
}

const summarize = (r: DecisionRecord | EntityProfile): string =>
  isDecisionRecord(r)
    ? `Decision: ${r.title} [${r.status}]`
    : `Profile: ${r.entityId}`;

export function makeLedger(client: LedgerClient, channelId: string): Ledger {
  // Read entire channel (newest-first), paging until exhausted.
  async function readAll(): Promise<Array<DecisionRecord | EntityProfile>> {
    const out: Array<DecisionRecord | EntityProfile> = [];
    let cursor: string | undefined;
    do {
      const res = await client.conversationsHistory({
        channel: channelId, include_all_metadata: true, cursor,
      });
      for (const m of res.messages ?? []) {
        const p = m.metadata?.event_payload;
        if (isDecisionRecord(p) || isEntityProfile(p)) out.push(p);
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out; // newest-first
  }

  async function write(payload: DecisionRecord | EntityProfile, eventType: string) {
    await client.chatPostMessage({
      channel: channelId,
      text: summarize(payload),
      metadata: { event_type: eventType, event_payload: payload },
    });
  }

  return {
    writeDecision: (r) => write(r, DECISION_EVENT_TYPE),
    writeProfile: (p) => write(p, PROFILE_EVENT_TYPE),

    async getProfile(id) {
      const all = await readAll(); // newest-first => first match is latest
      for (const r of all) if (isEntityProfile(r) && r.entityId === id) return r;
      return null;
    },

    async allDecisions() {
      const seen = new Set<string>();
      const out: DecisionRecord[] = [];
      for (const r of await readAll()) {
        if (isDecisionRecord(r) && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
      }
      return out;
    },

    async relatedDecisions(entities) {
      const want = new Set(entities);
      const all = await this.allDecisions(); // already newest-first, deduped
      return all.filter((d) => d.entities.some((e) => want.has(e)));
    },
  };
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run test/slack/ledger.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/slack/ledger.ts test/slack/ledger.test.ts
git commit -m "feat: Slack-native Ledger over message metadata"
```

---

### Task 3: RTS search wrapper + budget guard

**Files:**
- Create: `src/rts/budget.ts`, `src/rts/search.ts`
- Test: `test/rts/budget.test.ts`, `test/rts/search.test.ts`

**Interfaces:**
- Consumes: `ContextRef`, `Visibility` from `../types`.
- Produces:
  - `class SearchBudget { constructor(max: number); tryConsume(): boolean; remaining(): number; spent(): number; }`
  - `interface RtsClient { searchContext(a: { query: string; after?: string; disable_semantic_search?: boolean; action_token?: string }): Promise<{ results: Array<{ permalink: string; channel_id: string; ts: string; text: string; is_private?: boolean }> }>; searchInfo(): Promise<{ semantic_search_enabled: boolean }>; }`
  - `makeSearch(client: RtsClient, budget: SearchBudget): Search`
  - `interface Search { semanticAvailable(): Promise<boolean>; run(query: string, opts: { afterTs?: string }): Promise<ContextRef[]>; }`
  - `run` returns `[]` (never throws) once the budget is exhausted; maps `is_private` → `visibility`.

- [ ] **Step 1: Write the failing budget test**

```typescript
// test/rts/budget.test.ts
import { describe, it, expect } from "vitest";
import { SearchBudget } from "../../src/rts/budget";

describe("SearchBudget", () => {
  it("allows up to max consumes then blocks", () => {
    const b = new SearchBudget(2);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false);
    expect(b.spent()).toBe(2);
    expect(b.remaining()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run test/rts/budget.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/rts/budget.ts`**

```typescript
// src/rts/budget.ts
export class SearchBudget {
  private used = 0;
  constructor(private readonly max: number) {}
  tryConsume(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
  spent(): number { return this.used; }
  remaining(): number { return Math.max(0, this.max - this.used); }
}
```

- [ ] **Step 4: Run the budget test (PASS)**

Run: `npx vitest run test/rts/budget.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing search test**

```typescript
// test/rts/search.test.ts
import { describe, it, expect, vi } from "vitest";
import { makeSearch, type RtsClient } from "../../src/rts/search";
import { SearchBudget } from "../../src/rts/budget";

function fakeRts(over: Partial<RtsClient> = {}): RtsClient {
  return {
    searchContext: vi.fn(async () => ({
      results: [{ permalink: "p", channel_id: "C1", ts: "1.0", text: "hello world here", is_private: true }],
    })),
    searchInfo: vi.fn(async () => ({ semantic_search_enabled: false })),
    ...over,
  };
}

describe("Search", () => {
  it("maps results to provenance ContextRefs with truncated snippet + visibility", async () => {
    const rts = fakeRts();
    const search = makeSearch(rts, new SearchBudget(6));
    const refs = await search.run("why did we pick postgres", { afterTs: "1700" });
    expect(refs[0]).toMatchObject({ permalink: "p", channelId: "C1", ts: "1.0", visibility: "private" });
    expect(refs[0].snippet.length).toBeLessThanOrEqual(160);
    expect(rts.searchContext).toHaveBeenCalledWith(expect.objectContaining({ after: "1700" }));
  });

  it("returns [] without calling RTS once the budget is exhausted", async () => {
    const rts = fakeRts();
    const budget = new SearchBudget(1);
    const search = makeSearch(rts, budget);
    await search.run("q1", {});
    const refs = await search.run("q2", {});
    expect(refs).toEqual([]);
    expect(rts.searchContext).toHaveBeenCalledTimes(1);
  });

  it("disables semantic search when AI search is unavailable", async () => {
    const rts = fakeRts({ searchInfo: vi.fn(async () => ({ semantic_search_enabled: false })) });
    const search = makeSearch(rts, new SearchBudget(6));
    await search.run("q?", {});
    expect(rts.searchContext).toHaveBeenCalledWith(expect.objectContaining({ disable_semantic_search: true }));
  });
});
```

- [ ] **Step 6: Run it to confirm failure**

Run: `npx vitest run test/rts/search.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `src/rts/search.ts`**

```typescript
// src/rts/search.ts
import type { ContextRef, Visibility } from "../types.js";
import type { SearchBudget } from "./budget.js";

export interface RtsClient {
  searchContext(a: {
    query: string; after?: string;
    disable_semantic_search?: boolean; action_token?: string;
  }): Promise<{
    results: Array<{ permalink: string; channel_id: string; ts: string; text: string; is_private?: boolean }>;
  }>;
  searchInfo(): Promise<{ semantic_search_enabled: boolean }>;
}

export interface Search {
  semanticAvailable(): Promise<boolean>;
  run(query: string, opts: { afterTs?: string }): Promise<ContextRef[]>;
}

const SNIPPET_MAX = 160;

export function makeSearch(client: RtsClient, budget: SearchBudget): Search {
  let semantic: boolean | undefined;
  async function semanticAvailable() {
    if (semantic === undefined) semantic = (await client.searchInfo()).semantic_search_enabled;
    return semantic;
  }
  return {
    semanticAvailable,
    async run(query, opts) {
      if (!budget.tryConsume()) return [];
      const useSemantic = await semanticAvailable();
      const res = await client.searchContext({
        query,
        after: opts.afterTs,
        disable_semantic_search: !useSemantic,
      });
      return (res.results ?? []).map((r): ContextRef => ({
        permalink: r.permalink,
        channelId: r.channel_id,
        ts: r.ts,
        snippet: (r.text ?? "").slice(0, SNIPPET_MAX),
        visibility: (r.is_private ? "private" : "public") as Visibility,
      }));
    },
  };
}
```

- [ ] **Step 8: Run the search tests (PASS)**

Run: `npx vitest run test/rts/search.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add src/rts/budget.ts src/rts/search.ts test/rts/budget.test.ts test/rts/search.test.ts
git commit -m "feat: RTS search wrapper, keyword-first, with hard call budget"
```

---

### Task 4: LLM runtime — cached system, mid-conversation system, structured + bounded tool loop

**Files:**
- Create: `src/agent/llm.ts`
- Test: `test/agent/llm.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks (wraps `@anthropic-ai/sdk`).
- Produces:
  - `interface RawAnthropic { messages: { create(req: any): Promise<any> } }` (the slice we use; tests fake it)
  - `interface SystemBlock { type: "text"; text: string; cache_control?: { type: "ephemeral" } }`
  - `cachedSystem(instructions: string, staticProfile: string): SystemBlock[]` — bundles both, puts the single `cache_control` breakpoint on the last block.
  - `dynamicSystemMessage(dynamicProfile: string): { role: "system"; content: string }`
  - `class Llm { constructor(client: RawAnthropic); structured<T>(a: { system: SystemBlock[]; messages: any[]; schema: object }): Promise<T>; toolLoop(a: { system: SystemBlock[]; messages: any[]; tools: object[]; maxIterations: number; onToolUse: (name: string, input: any) => Promise<string> }): Promise<string>; }`
  - `MODEL = "claude-opus-4-8"`, request defaults: `thinking: {type:"adaptive"}`, `output_config: {effort:"high"}`, `max_tokens: 16000`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/agent/llm.test.ts
import { describe, it, expect, vi } from "vitest";
import { Llm, cachedSystem, dynamicSystemMessage, type RawAnthropic } from "../../src/agent/llm";

describe("cachedSystem", () => {
  it("bundles instructions + static profile under one cache breakpoint on the last block", () => {
    const blocks = cachedSystem("INSTR", "PROFILE");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1].text).toContain("PROFILE");
  });
});

describe("dynamicSystemMessage", () => {
  it("produces a role:system message (not a top-level system edit)", () => {
    expect(dynamicSystemMessage("DYN")).toEqual({ role: "system", content: "DYN" });
  });
});

describe("Llm.structured", () => {
  it("requests json_schema output and parses the first text block", async () => {
    const create = vi.fn(async () => ({ content: [{ type: "text", text: '{"ok":true}' }] }));
    const llm = new Llm({ messages: { create } } as RawAnthropic);
    const out = await llm.structured<{ ok: boolean }>({ system: cachedSystem("i", "p"), messages: [], schema: { type: "object" } });
    expect(out.ok).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "claude-opus-4-8",
      output_config: expect.objectContaining({ format: expect.objectContaining({ type: "json_schema" }) }),
    }));
  });
});

describe("Llm.toolLoop", () => {
  it("executes tool calls then returns final text, capped at maxIterations", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ stop_reason: "tool_use", content: [
        { type: "tool_use", id: "t1", name: "search", input: { query: "q" } },
      ]})
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "done" }] });
    const onToolUse = vi.fn(async () => "RESULT");
    const llm = new Llm({ messages: { create } } as RawAnthropic);
    const text = await llm.toolLoop({
      system: cachedSystem("i", "p"), messages: [{ role: "user", content: "go" }],
      tools: [{ name: "search" }], maxIterations: 6, onToolUse,
    });
    expect(text).toBe("done");
    expect(onToolUse).toHaveBeenCalledWith("search", { query: "q" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("stops at maxIterations even if the model keeps calling tools", async () => {
    const create = vi.fn(async () => ({ stop_reason: "tool_use", content: [
      { type: "tool_use", id: "t", name: "search", input: {} },
    ]}));
    const llm = new Llm({ messages: { create } } as RawAnthropic);
    const text = await llm.toolLoop({
      system: cachedSystem("i", "p"), messages: [{ role: "user", content: "go" }],
      tools: [{ name: "search" }], maxIterations: 3, onToolUse: async () => "R",
    });
    expect(create).toHaveBeenCalledTimes(3);
    expect(typeof text).toBe("string");
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run test/agent/llm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agent/llm.ts`**

```typescript
// src/agent/llm.ts
export const MODEL = "claude-opus-4-8";

export interface RawAnthropic {
  messages: { create(req: any): Promise<any> };
}

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export function cachedSystem(instructions: string, staticProfile: string): SystemBlock[] {
  return [
    { type: "text", text: instructions },
    { type: "text", text: `# Standing context\n${staticProfile}`, cache_control: { type: "ephemeral" } },
  ];
}

export const dynamicSystemMessage = (dynamicProfile: string) =>
  ({ role: "system" as const, content: dynamicProfile });

const BASE = {
  model: MODEL,
  max_tokens: 16000,
  thinking: { type: "adaptive" as const },
  output_config: { effort: "high" as const },
};

const firstText = (content: any[]): string =>
  content.find((b) => b.type === "text")?.text ?? "";

export class Llm {
  constructor(private readonly client: RawAnthropic) {}

  async structured<T>(a: { system: SystemBlock[]; messages: any[]; schema: object }): Promise<T> {
    const res = await this.client.messages.create({
      ...BASE,
      system: a.system,
      messages: a.messages,
      output_config: { ...BASE.output_config, format: { type: "json_schema", schema: a.schema } },
    });
    return JSON.parse(firstText(res.content)) as T;
  }

  async toolLoop(a: {
    system: SystemBlock[];
    messages: any[];
    tools: object[];
    maxIterations: number;
    onToolUse: (name: string, input: any) => Promise<string>;
  }): Promise<string> {
    const messages = [...a.messages];
    for (let i = 0; i < a.maxIterations; i++) {
      const res = await this.client.messages.create({
        ...BASE, system: a.system, tools: a.tools, messages,
      });
      messages.push({ role: "assistant", content: res.content });
      if (res.stop_reason !== "tool_use") return firstText(res.content);

      const toolUses = res.content.filter((b: any) => b.type === "tool_use");
      const results = [];
      for (const tu of toolUses) {
        const out = await a.onToolUse(tu.name, tu.input);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      messages.push({ role: "user", content: results });
    }
    // Budget/iteration cap hit — force a final, tool-free synthesis turn.
    const res = await this.client.messages.create({
      ...BASE, system: a.system, messages,
      tool_choice: { type: "none" },
    });
    return firstText(res.content);
  }
}
```

- [ ] **Step 4: Run the tests (PASS)**

Run: `npx vitest run test/agent/llm.test.ts`
Expected: PASS (5 tests). Note the second `toolLoop` test asserts `create` is called exactly `maxIterations` times; the cap path's extra forced call is reached only when the loop *completes* without `end_turn`. Confirm the count matches — if the forced-synthesis call pushes it to `maxIterations + 1`, adjust the loop to treat the final iteration as tool-free (see Step 5).

- [ ] **Step 5: Fix the iteration-cap accounting if needed**

If Step 4 shows `create` called `maxIterations + 1` times, change the loop so the final allowed iteration is the forced tool-free turn:

```typescript
    for (let i = 0; i < a.maxIterations; i++) {
      const last = i === a.maxIterations - 1;
      const res = await this.client.messages.create({
        ...BASE, system: a.system,
        ...(last ? { tool_choice: { type: "none" } } : { tools: a.tools }),
        messages,
      });
      messages.push({ role: "assistant", content: res.content });
      if (last || res.stop_reason !== "tool_use") return firstText(res.content);
      // ... (tool execution unchanged)
    }
    return "";
```
Re-run Step 4 until PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/llm.ts test/agent/llm.test.ts
git commit -m "feat: own-the-loop LLM runtime (cached system, mid-conv system, bounded tool loop)"
```

---

### Task 5: Permission scoping — provenance redaction + audience scoping

**Files:**
- Create: `src/permissions/scope.ts`
- Test: `test/permissions/scope.test.ts`

**Interfaces:**
- Consumes: `ContextRef`, `Visibility` from `../types`.
- Produces:
  - `type Audience = Visibility` (the broadest visibility the brief's readers share)
  - `scopeRefs(refs: ContextRef[], audience: Audience): { inline: ContextRef[]; linkOnly: ContextRef[] }` — a ref is inline-able only if its source is at least as open as the audience; otherwise it becomes a permission-gated link.
  - `renderRef(ref: ContextRef, inline: boolean): string` — inline = `> snippet — <permalink>`; link-only = `🔒 <permalink|source>` (no snippet, so the viewer's own permission gates it).

- [ ] **Step 1: Write the failing test**

```typescript
// test/permissions/scope.test.ts
import { describe, it, expect } from "vitest";
import { scopeRefs, renderRef } from "../../src/permissions/scope";
import type { ContextRef } from "../../src/types";

const ref = (visibility: ContextRef["visibility"]): ContextRef =>
  ({ permalink: "p", channelId: "C", ts: "1.0", snippet: "secret detail", visibility });

describe("scopeRefs", () => {
  it("keeps public refs inline for a private-audience brief", () => {
    const { inline, linkOnly } = scopeRefs([ref("public")], "private");
    expect(inline).toHaveLength(1);
    expect(linkOnly).toHaveLength(0);
  });
  it("downgrades private refs to link-only for a public-audience brief", () => {
    const { inline, linkOnly } = scopeRefs([ref("private")], "public");
    expect(inline).toHaveLength(0);
    expect(linkOnly).toHaveLength(1);
  });
});

describe("renderRef", () => {
  it("omits the snippet for link-only refs (no laundering)", () => {
    expect(renderRef(ref("private"), false)).not.toContain("secret detail");
    expect(renderRef(ref("public"), true)).toContain("secret detail");
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run test/permissions/scope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/permissions/scope.ts`**

```typescript
// src/permissions/scope.ts
import type { ContextRef, Visibility } from "../types.js";

export type Audience = Visibility;

// Higher = more open. A ref is inline-able iff its source is at least as open as the audience.
const OPENNESS: Record<Visibility, number> = { dm: 0, private: 1, public: 2 };

export function scopeRefs(refs: ContextRef[], audience: Audience) {
  const inline: ContextRef[] = [];
  const linkOnly: ContextRef[] = [];
  for (const r of refs) {
    if (OPENNESS[r.visibility] >= OPENNESS[audience]) inline.push(r);
    else linkOnly.push(r);
  }
  return { inline, linkOnly };
}

export function renderRef(ref: ContextRef, inline: boolean): string {
  return inline
    ? `> ${ref.snippet} — ${ref.permalink}`
    : `🔒 <${ref.permalink}|source> (open to check — your access applies)`;
}
```

- [ ] **Step 4: Run the tests (PASS)**

Run: `npx vitest run test/permissions/scope.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/permissions/scope.ts test/permissions/scope.test.ts
git commit -m "feat: permission scoping (provenance-not-payload, audience-gated refs)"
```

---

### Task 6: Resolve, gap-check, synthesize — the LLM steps

**Files:**
- Create: `src/agent/resolve.ts`, `src/agent/gapcheck.ts`, `src/agent/synthesize.ts`
- Test: `test/agent/resolve.test.ts`, `test/agent/gapcheck.test.ts`, `test/agent/synthesize.test.ts`

**Interfaces:**
- Consumes: `Llm`, `cachedSystem`, `dynamicSystemMessage` from `./llm`; `Search` from `../rts/search`; `ContextRef`, `EntityId` from `../types`.
- Produces:
  - `interface Resolved { decisionStatement: string; options: string[]; entities: EntityId[]; openQuestions: string[]; title: string }`
  - `resolveThread(llm: Llm, threadText: string, seedEntities: EntityId[]): Promise<Resolved>`
  - `gatherContext(a: { llm: Llm; search: Search; staticProfile: string; dynamicProfile: string; resolved: Resolved }): Promise<ContextRef[]>` — runs the bounded tool loop; the `search` tool is the only tool; returns the accumulated `ContextRef[]`.
  - `interface Brief { title: string; decisionText: string; optionsConsidered: string[]; rationale: string; proposedOwners: { userId: string; task: string }[]; openQuestions: string[]; bodySummary: string }`
  - `synthesizeBrief(a: { llm: Llm; staticProfile: string; dynamicProfile: string; resolved: Resolved; refs: ContextRef[] }): Promise<Brief>`

- [ ] **Step 1: Write the failing resolve test**

```typescript
// test/agent/resolve.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveThread } from "../../src/agent/resolve";
import { Llm } from "../../src/agent/llm";

describe("resolveThread", () => {
  it("returns the structured resolution and merges seed entities", async () => {
    const create = vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify({
      decisionStatement: "Adopt Postgres", options: ["Postgres", "Dynamo"],
      entities: ["project:atlas"], openQuestions: ["dual-write?"], title: "DB choice",
    })}]}));
    const llm = new Llm({ messages: { create } } as any);
    const r = await resolveThread(llm, "thread text", ["channel:C1"]);
    expect(r.title).toBe("DB choice");
    expect(r.entities).toEqual(expect.arrayContaining(["project:atlas", "channel:C1"]));
  });
});
```

- [ ] **Step 2: Run it (FAIL), then implement `src/agent/resolve.ts`**

Run: `npx vitest run test/agent/resolve.test.ts` → FAIL (module not found).

```typescript
// src/agent/resolve.ts
import { Llm, cachedSystem } from "./llm.js";
import type { EntityId } from "../types.js";

export interface Resolved {
  decisionStatement: string;
  options: string[];
  entities: EntityId[];
  openQuestions: string[];
  title: string;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decisionStatement: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    entities: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
    title: { type: "string" },
  },
  required: ["decisionStatement", "options", "entities", "openQuestions", "title"],
} as const;

const INSTR =
  "You extract the decision being made from a Slack thread. Identify the decision " +
  "statement, the options considered, the salient entities (people, projects, systems) " +
  "as id strings, any open questions, and a short title. Be precise; do not invent.";

export async function resolveThread(llm: Llm, threadText: string, seedEntities: EntityId[]): Promise<Resolved> {
  const out = await llm.structured<Resolved>({
    system: cachedSystem(INSTR, ""),
    messages: [{ role: "user", content: `Thread:\n${threadText}` }],
    schema: SCHEMA as object,
  });
  const entities = Array.from(new Set([...out.entities, ...seedEntities]));
  return { ...out, entities };
}
```

Re-run Step 1 → PASS.

- [ ] **Step 3: Write the failing gapcheck test**

```typescript
// test/agent/gapcheck.test.ts
import { describe, it, expect, vi } from "vitest";
import { gatherContext } from "../../src/agent/gapcheck";
import { Llm } from "../../src/agent/llm";
import { makeSearch } from "../../src/rts/search";
import { SearchBudget } from "../../src/rts/budget";

describe("gatherContext", () => {
  it("runs the bounded search tool loop and accumulates ContextRefs", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ stop_reason: "tool_use", content: [
        { type: "tool_use", id: "t1", name: "search", input: { query: "postgres decision" } },
      ]})
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "enough" }] });
    const llm = new Llm({ messages: { create } } as any);
    const rts = {
      searchContext: vi.fn(async () => ({ results: [{ permalink: "p", channel_id: "C1", ts: "1.0", text: "ctx", is_private: false }] })),
      searchInfo: vi.fn(async () => ({ semantic_search_enabled: false })),
    };
    const search = makeSearch(rts, new SearchBudget(6));
    const refs = await gatherContext({
      llm, search, staticProfile: "S", dynamicProfile: "D", afterTs: "0",
      resolved: { decisionStatement: "x", options: [], entities: [], openQuestions: ["q"], title: "t" },
    });
    expect(refs.map((r) => r.permalink)).toEqual(["p"]);
    expect(rts.searchContext).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 4: Run it (FAIL), then implement `src/agent/gapcheck.ts`**

```typescript
// src/agent/gapcheck.ts
import { Llm, cachedSystem, dynamicSystemMessage } from "./llm.js";
import type { Search } from "../rts/search.js";
import type { ContextRef } from "../types.js";
import type { Resolved } from "./resolve.js";

const INSTR =
  "You are filling gaps for a decision brief. You already have the standing context " +
  "below. Call `search` ONLY for what is genuinely missing — prior related decisions, " +
  "owners, constraints. Each query is a real-time workspace search run AS the invoking " +
  "user. Prefer a question phrasing. Stop as soon as the brief's open questions are " +
  "answerable. When done, reply with a one-line note; do not call search again.";

const SEARCH_TOOL = {
  name: "search",
  description: "Search the Slack workspace (as the invoking user) for context relevant to the decision.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: { query: { type: "string", description: "Natural-language search query" } },
    required: ["query"],
  },
};

export async function gatherContext(a: {
  llm: Llm; search: Search;
  staticProfile: string; dynamicProfile: string; resolved: Resolved;
  afterTs: string; // the entity's dynamic.searchCursor.untilTs ("0" = cold / search all time)
}): Promise<ContextRef[]> {
  const refs: ContextRef[] = [];
  await a.llm.toolLoop({
    system: cachedSystem(INSTR, a.staticProfile),
    messages: [
      dynamicSystemMessage(a.dynamicProfile),
      { role: "user", content:
        `Decision: ${a.resolved.decisionStatement}\nOpen questions: ${a.resolved.openQuestions.join("; ")}` },
    ],
    tools: [SEARCH_TOOL],
    maxIterations: 6,
    onToolUse: async (_name, input) => {
      const found = await a.search.run(input.query, { afterTs: a.afterTs }); // delta-scoped
      refs.push(...found);
      return found.length
        ? found.map((r) => `- ${r.snippet} (${r.permalink})`).join("\n")
        : "No new results.";
    },
  });
  return refs;
}
```

Re-run Step 3 → PASS.

- [ ] **Step 5: Write the failing synthesize test**

```typescript
// test/agent/synthesize.test.ts
import { describe, it, expect, vi } from "vitest";
import { synthesizeBrief } from "../../src/agent/synthesize";
import { Llm } from "../../src/agent/llm";

describe("synthesizeBrief", () => {
  it("produces a structured brief from thread + refs", async () => {
    const create = vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify({
      title: "DB choice", decisionText: "Use Postgres", optionsConsidered: ["Postgres", "Dynamo"],
      rationale: "ACID + team familiarity", proposedOwners: [{ userId: "U1", task: "migrate" }],
      openQuestions: [], bodySummary: "We chose Postgres because...",
    })}]}));
    const llm = new Llm({ messages: { create } } as any);
    const brief = await synthesizeBrief({
      llm, staticProfile: "S", dynamicProfile: "D",
      resolved: { decisionStatement: "x", options: [], entities: [], openQuestions: [], title: "t" },
      refs: [{ permalink: "p", channelId: "C1", ts: "1.0", snippet: "s", visibility: "public" }],
    });
    expect(brief.decisionText).toBe("Use Postgres");
    expect(brief.proposedOwners[0].userId).toBe("U1");
  });
});
```

- [ ] **Step 6: Run it (FAIL), then implement `src/agent/synthesize.ts`**

```typescript
// src/agent/synthesize.ts
import { Llm, cachedSystem, dynamicSystemMessage } from "./llm.js";
import type { ContextRef } from "../types.js";
import type { Resolved } from "./resolve.js";

export interface Brief {
  title: string;
  decisionText: string;
  optionsConsidered: string[];
  rationale: string;
  proposedOwners: { userId: string; task: string }[];
  openQuestions: string[];
  bodySummary: string;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    decisionText: { type: "string" },
    optionsConsidered: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
    proposedOwners: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: { userId: { type: "string" }, task: { type: "string" } },
        required: ["userId", "task"],
      },
    },
    openQuestions: { type: "array", items: { type: "string" } },
    bodySummary: { type: "string" },
  },
  required: ["title", "decisionText", "optionsConsidered", "rationale", "proposedOwners", "openQuestions", "bodySummary"],
} as const;

const INSTR =
  "You write a crisp decision brief. Use ONLY the supplied thread, retrieved context, " +
  "and standing context. State the decision, the options considered, the rationale, " +
  "proposed owners (with user ids when named), and any still-open questions. " +
  "`bodySummary` is a few human-readable sentences for a channel reader.";

export async function synthesizeBrief(a: {
  llm: Llm; staticProfile: string; dynamicProfile: string;
  resolved: Resolved; refs: ContextRef[];
}): Promise<Brief> {
  const refsText = a.refs.map((r) => `- ${r.snippet} (${r.permalink})`).join("\n");
  return a.llm.structured<Brief>({
    system: cachedSystem(INSTR, a.staticProfile),
    messages: [
      dynamicSystemMessage(a.dynamicProfile),
      { role: "user", content:
        `Decision: ${a.resolved.decisionStatement}\nOptions: ${a.resolved.options.join(", ")}\n` +
        `Open questions: ${a.resolved.openQuestions.join("; ")}\nRetrieved context:\n${refsText}` },
    ],
    schema: SCHEMA as object,
  });
}
```

Re-run Step 5 → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agent/resolve.ts src/agent/gapcheck.ts src/agent/synthesize.ts test/agent/resolve.test.ts test/agent/gapcheck.test.ts test/agent/synthesize.test.ts
git commit -m "feat: resolve / gap-check / synthesize LLM steps"
```

---

### Task 7: Observer — inline profile consolidation

**Files:**
- Create: `src/memory/observer.ts`
- Test: `test/memory/observer.test.ts`

**Interfaces:**
- Consumes: `Llm`, `cachedSystem` from `../agent/llm`; `EntityProfile`, `StaticProfile`, `DynamicProfile`, `DecisionRecord`, `EntityId` from `../types`.
- Produces:
  - `coldProfile(entityId: EntityId, now: string): EntityProfile` — empty warm-start scaffold for a never-seen entity (used when no profile exists; `searchCursor.untilTs = "0"`).
  - `consolidate(a: { llm: Llm; prior: EntityProfile; newDecision: DecisionRecord; recentRefs: { permalink: string; snippet: string; ts: string }[]; newCursorTs: string; now: string }): Promise<EntityProfile>` — folds the finalized decision + recent refs into the dynamic profile, rewrites static only on drift, advances `searchCursor.untilTs`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/memory/observer.test.ts
import { describe, it, expect, vi } from "vitest";
import { coldProfile, consolidate } from "../../src/memory/observer";
import { Llm } from "../../src/agent/llm";
import type { DecisionRecord } from "../../src/types";

const decision: DecisionRecord = {
  recordType: "decision_record", id: "d9", title: "DB", status: "decided",
  origin: { channelId: "C1", threadTs: "1.0" }, capturer: "U1", approvers: ["U2"],
  decisionText: "Use Postgres", optionsConsidered: [], rationale: "r", owners: [],
  entities: ["channel:C1"], relatedDecisionIds: [], contextRefs: [],
};

describe("observer", () => {
  it("coldProfile scaffolds a zero cursor", () => {
    const p = coldProfile("channel:C1", "t0");
    expect(p.dynamic.searchCursor.untilTs).toBe("0");
    expect(p.entityId).toBe("channel:C1");
  });

  it("consolidate advances the cursor and adds the decision to in-flight history", async () => {
    const create = vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify({
      static: { summary: "billing area", keyPeople: ["U1"], keySystems: ["postgres"], decisionNorms: "eng+finance", builtAt: "t1" },
      dynamic: { inFlightDecisions: ["d9"], recentThreads: [], openQuestions: [], searchCursor: { untilTs: "IGNORED" }, refreshedAt: "t1" },
    })}]}));
    const llm = new Llm({ messages: { create } } as any);
    const prior = coldProfile("channel:C1", "t0");
    const next = await consolidate({ llm, prior, newDecision: decision, recentRefs: [], newCursorTs: "1700", now: "t1" });
    expect(next.dynamic.searchCursor.untilTs).toBe("1700"); // code overrides model's cursor
    expect(next.dynamic.inFlightDecisions).toContain("d9");
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run test/memory/observer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/memory/observer.ts`**

```typescript
// src/memory/observer.ts
import { Llm, cachedSystem } from "../agent/llm.js";
import type { DecisionRecord, EntityId, EntityProfile } from "../types.js";

export function coldProfile(entityId: EntityId, now: string): EntityProfile {
  return {
    recordType: "entity_profile",
    entityId,
    static: { summary: "", keyPeople: [], keySystems: [], decisionNorms: "", builtAt: now },
    dynamic: { inFlightDecisions: [], recentThreads: [], openQuestions: [], searchCursor: { untilTs: "0" }, refreshedAt: now },
  };
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    static: {
      type: "object", additionalProperties: false,
      properties: {
        summary: { type: "string" }, keyPeople: { type: "array", items: { type: "string" } },
        keySystems: { type: "array", items: { type: "string" } }, decisionNorms: { type: "string" }, builtAt: { type: "string" },
      },
      required: ["summary", "keyPeople", "keySystems", "decisionNorms", "builtAt"],
    },
    dynamic: {
      type: "object", additionalProperties: false,
      properties: {
        inFlightDecisions: { type: "array", items: { type: "string" } },
        recentThreads: { type: "array", items: { type: "object", additionalProperties: false,
          properties: { permalink: { type: "string" }, snippet: { type: "string" }, ts: { type: "string" } },
          required: ["permalink", "snippet", "ts"] } },
        openQuestions: { type: "array", items: { type: "string" } },
        searchCursor: { type: "object", additionalProperties: false, properties: { untilTs: { type: "string" } }, required: ["untilTs"] },
        refreshedAt: { type: "string" },
      },
      required: ["inFlightDecisions", "recentThreads", "openQuestions", "searchCursor", "refreshedAt"],
    },
  },
  required: ["static", "dynamic"],
} as const;

const INSTR =
  "You are the memory observer. Fold the newly finalized decision and recent threads " +
  "into a compact entity profile. Keep `static` stable — only rewrite it if the area's " +
  "nature, key people, or norms actually drifted. Keep `dynamic` to the delta: in-flight " +
  "decision ids, a few recent threads, and still-open questions. Be terse; profiles must " +
  "stay small enough to inject every turn and stable enough to prompt-cache. Provenance " +
  "only — snippets, never full bodies.";

export async function consolidate(a: {
  llm: Llm; prior: EntityProfile; newDecision: DecisionRecord;
  recentRefs: { permalink: string; snippet: string; ts: string }[];
  newCursorTs: string; now: string;
}): Promise<EntityProfile> {
  const out = await a.llm.structured<Pick<EntityProfile, "static" | "dynamic">>({
    system: cachedSystem(INSTR, ""),
    messages: [{ role: "user", content:
      `Prior profile:\n${JSON.stringify(a.prior)}\n\n` +
      `Newly finalized decision:\n${JSON.stringify({ id: a.newDecision.id, title: a.newDecision.title, decisionText: a.newDecision.decisionText, rationale: a.newDecision.rationale })}\n\n` +
      `Recent threads:\n${JSON.stringify(a.recentRefs)}` }],
    schema: SCHEMA as object,
  });
  // Code is authoritative for the cursor and refreshedAt — never trust the model here.
  return {
    recordType: "entity_profile",
    entityId: a.prior.entityId,
    static: { ...out.static, builtAt: out.static.builtAt || a.prior.static.builtAt },
    dynamic: { ...out.dynamic, searchCursor: { untilTs: a.newCursorTs }, refreshedAt: a.now },
  };
}
```

- [ ] **Step 4: Run the tests (PASS)**

Run: `npx vitest run test/memory/observer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/memory/observer.ts test/memory/observer.test.ts
git commit -m "feat: inline observer — consolidate decisions into static/dynamic profiles"
```

---

### Task 8: Capture orchestration (steps 1–10) + cold-vs-warm proof

**Files:**
- Create: `src/agent/capture.ts`
- Test: `test/agent/capture.test.ts`

**Interfaces:**
- Consumes: `Ledger` (`makeLedger`), `Search` (`makeSearch`), `Llm`, `resolveThread`, `gatherContext`, `synthesizeBrief`, `coldProfile`, `scopeRefs`, types.
- Produces:
  - `interface CaptureInput { channelId: string; threadTs: string; capturer: string; threadText: string }`
  - `interface CaptureResult { brief: Brief; refs: ContextRef[]; resolved: Resolved; profile: EntityProfile; rtsCalls: number }`
  - `runCapture(deps: { ledger: Ledger; llm: Llm; search: Search; budget: SearchBudget; now: string }, input: CaptureInput): Promise<CaptureResult>` — performs steps 2–7, building context warm (profile from Ledger) or cold (inline `coldProfile`). Does NOT post the brief/Canvas (that is Task 9/10) — it returns the materials. `rtsCalls = budget.spent()`.

- [ ] **Step 1: Write the failing test (warm start spends fewer RTS calls than cold)**

```typescript
// test/agent/capture.test.ts
import { describe, it, expect, vi } from "vitest";
import { runCapture } from "../../src/agent/capture";
import { makeLedger } from "../../src/slack/ledger";
import { makeSearch } from "../../src/rts/search";
import { SearchBudget } from "../../src/rts/budget";
import { Llm } from "../../src/agent/llm";
import { coldProfile } from "../../src/memory/observer";

function fakeLedgerClient() {
  const messages: any[] = [];
  return {
    async chatPostMessage(a: any) { messages.unshift({ metadata: a.metadata }); },
    async conversationsHistory() { return { messages }; },
  };
}

// LLM that: resolves, then in gap-check calls `search` N times based on how many
// open questions remain unanswered. We simulate "warm" by pre-seeding a profile so
// the resolve step yields zero open questions -> zero searches.
function scriptedLlm(searchCalls: number) {
  let phase = 0;
  const create = vi.fn(async (req: any) => {
    // resolve (structured) -> gapcheck (tool loop) -> synthesize (structured)
    if (req.output_config?.format) {
      phase++;
      if (phase === 1) return { content: [{ type: "text", text: JSON.stringify({
        decisionStatement: "Adopt Postgres", options: ["pg", "dynamo"],
        entities: ["channel:C1"], openQuestions: searchCalls ? ["q"] : [], title: "DB",
      })}]};
      return { content: [{ type: "text", text: JSON.stringify({
        title: "DB", decisionText: "pg", optionsConsidered: ["pg"], rationale: "r",
        proposedOwners: [], openQuestions: [], bodySummary: "b",
      })}]};
    }
    // tool loop turns
    if (searchCalls > 0) { searchCalls--; return { stop_reason: "tool_use", content: [
      { type: "tool_use", id: "t", name: "search", input: { query: "q" } } ]}; }
    return { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] };
  });
  return new Llm({ messages: { create } } as any);
}

const rts = () => ({
  searchContext: vi.fn(async () => ({ results: [{ permalink: "p", channel_id: "C1", ts: "1.0", text: "c", is_private: false }] })),
  searchInfo: vi.fn(async () => ({ semantic_search_enabled: false })),
});

describe("runCapture", () => {
  it("cold start (no profile) performs searches; warm start (seeded profile) performs none", async () => {
    // COLD
    const coldClient = fakeLedgerClient();
    const coldLedger = makeLedger(coldClient as any, "CLEDGER");
    const coldBudget = new SearchBudget(6);
    const coldRes = await runCapture(
      { ledger: coldLedger, llm: scriptedLlm(2), search: makeSearch(rts() as any, coldBudget), budget: coldBudget, now: "t" },
      { channelId: "C1", threadTs: "1.0", capturer: "U1", threadText: "..." });
    expect(coldRes.rtsCalls).toBeGreaterThan(0);

    // WARM: seed a rich profile so resolve yields no open questions -> no searches
    const warmClient = fakeLedgerClient();
    const warmLedger = makeLedger(warmClient as any, "CLEDGER");
    await warmLedger.writeProfile({ ...coldProfile("channel:C1", "t"),
      static: { summary: "billing", keyPeople: ["U1"], keySystems: ["pg"], decisionNorms: "n", builtAt: "t" } });
    const warmBudget = new SearchBudget(6);
    const warmRes = await runCapture(
      { ledger: warmLedger, llm: scriptedLlm(0), search: makeSearch(rts() as any, warmBudget), budget: warmBudget, now: "t" },
      { channelId: "C1", threadTs: "1.0", capturer: "U1", threadText: "..." });
    expect(warmRes.rtsCalls).toBe(0);
    expect(warmRes.rtsCalls).toBeLessThan(coldRes.rtsCalls);
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run test/agent/capture.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agent/capture.ts`**

```typescript
// src/agent/capture.ts
import type { Ledger } from "../slack/ledger.js";
import type { Search } from "../rts/search.js";
import type { SearchBudget } from "../rts/budget.js";
import { Llm } from "./llm.js";
import { resolveThread, type Resolved } from "./resolve.js";
import { gatherContext } from "./gapcheck.js";
import { synthesizeBrief, type Brief } from "./synthesize.js";
import { coldProfile } from "../memory/observer.js";
import { entityIdForChannel, type ContextRef, type EntityProfile } from "../types.js";

export interface CaptureInput {
  channelId: string;
  threadTs: string;
  capturer: string;
  threadText: string;
}

export interface CaptureResult {
  brief: Brief;
  refs: ContextRef[];
  resolved: Resolved;
  profile: EntityProfile;
  rtsCalls: number;
}

const profileToStatic = (p: EntityProfile): string => JSON.stringify(p.static);
const profileToDynamic = (p: EntityProfile): string => JSON.stringify(p.dynamic);

export async function runCapture(
  deps: { ledger: Ledger; llm: Llm; search: Search; budget: SearchBudget; now: string },
  input: CaptureInput
): Promise<CaptureResult> {
  const seed = entityIdForChannel(input.channelId);

  // Step 3: resolve the decision from the thread.
  const resolved = await resolveThread(deps.llm, input.threadText, [seed]);

  // Step 4 (Recall): pull the entity profile; cold-start inline if none exists.
  const primaryEntity = resolved.entities[0] ?? seed;
  const profile =
    (await deps.ledger.getProfile(primaryEntity)) ?? coldProfile(primaryEntity, deps.now);

  // Steps 5–6: bounded, delta-scoped gap search (cursor lives in the dynamic profile).
  const refs = await gatherContext({
    llm: deps.llm, search: deps.search,
    staticProfile: profileToStatic(profile),
    dynamicProfile: profileToDynamic(profile),
    resolved,
    afterTs: profile.dynamic.searchCursor.untilTs, // delta cursor: "0" cold, last-seen ts warm
  });

  // Step 7: synthesize the brief.
  const brief = await synthesizeBrief({
    llm: deps.llm, staticProfile: profileToStatic(profile),
    dynamicProfile: profileToDynamic(profile), resolved, refs,
  });

  return { brief, refs, resolved, profile, rtsCalls: deps.budget.spent() };
}
```

- [ ] **Step 4: Run the test (PASS)**

Run: `npx vitest run test/agent/capture.test.ts`
Expected: PASS. This test **is the cold-vs-warm thesis check** in miniature — warm captures spend 0 RTS calls, cold spend > 0.

- [ ] **Step 5: Commit**

```bash
git add src/agent/capture.ts test/agent/capture.test.ts
git commit -m "feat: capture orchestration (steps 2-7) with cold-vs-warm RTS proof"
```

---

### Task 9: Canvas brief + Block Kit builders

**Files:**
- Create: `src/slack/canvas.ts`, `src/slack/blocks.ts`
- Test: `test/slack/canvas.test.ts`, `test/slack/blocks.test.ts`

**Interfaces:**
- Consumes: `Brief` from `../agent/synthesize`; `ContextRef` from `../types`; `scopeRefs`, `renderRef` from `../permissions/scope`.
- Produces:
  - `interface CanvasClient { canvasesCreate(a: { title: string; document_content: { type: "markdown"; markdown: string } }): Promise<{ canvas_id: string }>; canvasesEdit(a: { canvas_id: string; changes: any[] }): Promise<void> }`
  - `renderBriefMarkdown(brief: Brief, refs: ContextRef[], audience: Visibility): string`
  - `createBriefCanvas(client: CanvasClient, brief: Brief, refs: ContextRef[], audience: Visibility): Promise<string>` (returns canvas_id)
  - `markCanvasDecided(client: CanvasClient, canvasId: string, decisionText: string): Promise<void>`
  - `approvalBlocks(decisionId: string, brief: Brief): any[]` — Block Kit with Approve / Revise / Reject buttons (action_ids `approve|revise|reject`, `value` = decisionId)
  - `finalDecisionBlocks(brief: Brief, owners: { userId: string; task: string }[]): any[]`

- [ ] **Step 1: Write the failing canvas test**

```typescript
// test/slack/canvas.test.ts
import { describe, it, expect, vi } from "vitest";
import { renderBriefMarkdown, createBriefCanvas, markCanvasDecided } from "../../src/slack/canvas";
import type { Brief } from "../../src/agent/synthesize";

const brief: Brief = {
  title: "DB choice", decisionText: "Use Postgres", optionsConsidered: ["Postgres", "Dynamo"],
  rationale: "ACID", proposedOwners: [{ userId: "U1", task: "migrate" }], openQuestions: ["dual-write?"],
  bodySummary: "We chose Postgres.",
};

describe("canvas", () => {
  it("renders markdown with decision, options, and an audience-gated source that hides private snippets", () => {
    const md = renderBriefMarkdown(brief, [
      { permalink: "pub", channelId: "C1", ts: "1", snippet: "public detail", visibility: "public" },
      { permalink: "priv", channelId: "C2", ts: "2", snippet: "secret detail", visibility: "private" },
    ], "public");
    expect(md).toContain("Use Postgres");
    expect(md).toContain("public detail");
    expect(md).not.toContain("secret detail"); // private ref is link-only for a public brief
    expect(md).toContain("priv");              // but the link is present
  });

  it("creates a canvas and returns the id", async () => {
    const client = { canvasesCreate: vi.fn(async () => ({ canvas_id: "F123" })), canvasesEdit: vi.fn() };
    const id = await createBriefCanvas(client as any, brief, [], "public");
    expect(id).toBe("F123");
  });

  it("marks the canvas decided via an edit", async () => {
    const client = { canvasesCreate: vi.fn(), canvasesEdit: vi.fn(async () => {}) };
    await markCanvasDecided(client as any, "F123", "Use Postgres");
    expect(client.canvasesEdit).toHaveBeenCalledWith(expect.objectContaining({ canvas_id: "F123" }));
  });
});
```

- [ ] **Step 2: Run it (FAIL), then implement `src/slack/canvas.ts`**

```typescript
// src/slack/canvas.ts
import type { Brief } from "../agent/synthesize.js";
import type { ContextRef, Visibility } from "../types.js";
import { scopeRefs, renderRef } from "../permissions/scope.js";

export interface CanvasClient {
  canvasesCreate(a: { title: string; document_content: { type: "markdown"; markdown: string } }): Promise<{ canvas_id: string }>;
  canvasesEdit(a: { canvas_id: string; changes: any[] }): Promise<void>;
}

export function renderBriefMarkdown(brief: Brief, refs: ContextRef[], audience: Visibility): string {
  const { inline, linkOnly } = scopeRefs(refs, audience);
  const sources = [...inline.map((r) => renderRef(r, true)), ...linkOnly.map((r) => renderRef(r, false))];
  return [
    `# ${brief.title}`,
    `**Status:** Draft`,
    ``,
    `## Decision`,
    brief.decisionText,
    ``,
    `## Options considered`,
    ...brief.optionsConsidered.map((o) => `- ${o}`),
    ``,
    `## Rationale`,
    brief.rationale,
    ``,
    `## Proposed owners`,
    ...(brief.proposedOwners.length ? brief.proposedOwners.map((o) => `- <@${o.userId}> — ${o.task}`) : ["- _none yet_"]),
    ``,
    `## Open questions`,
    ...(brief.openQuestions.length ? brief.openQuestions.map((q) => `- ${q}`) : ["- _none_"]),
    ``,
    `## Sources`,
    ...(sources.length ? sources : ["- _none_"]),
  ].join("\n");
}

export async function createBriefCanvas(client: CanvasClient, brief: Brief, refs: ContextRef[], audience: Visibility): Promise<string> {
  const res = await client.canvasesCreate({
    title: brief.title,
    document_content: { type: "markdown", markdown: renderBriefMarkdown(brief, refs, audience) },
  });
  return res.canvas_id;
}

export async function markCanvasDecided(client: CanvasClient, canvasId: string, decisionText: string): Promise<void> {
  // Canvas is write-only; append a decided banner. (replace section by id is also valid;
  // append keeps v1 simple and avoids a sections.lookup round-trip.)
  await client.canvasesEdit({
    canvas_id: canvasId,
    changes: [{ operation: "insert_at_start", document_content: { type: "markdown", markdown: `> ✅ **DECIDED** — ${decisionText}\n\n` } }],
  });
}
```

Re-run Step 1 → PASS.

- [ ] **Step 3: Write the failing blocks test**

```typescript
// test/slack/blocks.test.ts
import { describe, it, expect } from "vitest";
import { approvalBlocks, finalDecisionBlocks } from "../../src/slack/blocks";
import type { Brief } from "../../src/agent/synthesize";

const brief: Brief = {
  title: "DB", decisionText: "Use Postgres", optionsConsidered: [], rationale: "r",
  proposedOwners: [{ userId: "U1", task: "migrate" }], openQuestions: [], bodySummary: "b",
};

describe("blocks", () => {
  it("builds an approval card with three actions carrying the decision id", () => {
    const blocks = approvalBlocks("d1", brief);
    const actions = blocks.find((b: any) => b.type === "actions");
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).toEqual(["approve", "revise", "reject"]);
    expect(actions.elements.every((e: any) => e.value === "d1")).toBe(true);
  });

  it("builds a final decision block that @-mentions owners", () => {
    const blocks = finalDecisionBlocks(brief, [{ userId: "U1", task: "migrate" }]);
    const text = JSON.stringify(blocks);
    expect(text).toContain("<@U1>");
    expect(text).toContain("migrate");
  });
});
```

- [ ] **Step 4: Run it (FAIL), then implement `src/slack/blocks.ts`**

```typescript
// src/slack/blocks.ts
import type { Brief } from "../agent/synthesize.js";

export function approvalBlocks(decisionId: string, brief: Brief): any[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `*Decision brief:* ${brief.title}\n${brief.bodySummary}` } },
    { type: "actions", elements: [
      { type: "button", action_id: "approve", style: "primary", text: { type: "plain_text", text: "Approve" }, value: decisionId },
      { type: "button", action_id: "revise", text: { type: "plain_text", text: "Revise" }, value: decisionId },
      { type: "button", action_id: "reject", style: "danger", text: { type: "plain_text", text: "Reject" }, value: decisionId },
    ]},
  ];
}

export function finalDecisionBlocks(brief: Brief, owners: { userId: string; task: string }[]): any[] {
  const ownerLines = owners.length
    ? owners.map((o) => `• <@${o.userId}> — ${o.task}`).join("\n")
    : "_no follow-up owners_";
  return [
    { type: "section", text: { type: "mrkdwn", text: `✅ *Decided:* ${brief.decisionText}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Follow-ups:*\n${ownerLines}` } },
  ];
}
```

Re-run Step 3 → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/slack/canvas.ts src/slack/blocks.ts test/slack/canvas.test.ts test/slack/blocks.test.ts
git commit -m "feat: Canvas brief rendering + Block Kit approval/final builders"
```

---

### Task 10: Thread hydration + config + Bolt app wiring

**Files:**
- Create: `src/slack/thread.ts`, `src/config.ts`, `src/app.ts`
- Test: `test/slack/thread.test.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `hydrateThread(client: { conversationsReplies(a: any): Promise<{ messages: Array<{ user?: string; text?: string }> }> }, channelId: string, threadTs: string): Promise<string>` — returns flattened `@user: text` thread text.
  - `loadConfig(env: NodeJS.ProcessEnv): Config` with `{ botToken, appToken, signingSecret, workspaceToken, ledgerChannelId, anthropicKey }`; throws on any missing key.
  - `src/app.ts` registers the `capture_decision` message shortcut and `approve|revise|reject` actions, and runs the finalize path. (Wiring is integration glue — its test is the manual run in Verification, not a unit test.)

- [ ] **Step 1: Write the failing thread + config tests**

```typescript
// test/slack/thread.test.ts
import { describe, it, expect, vi } from "vitest";
import { hydrateThread } from "../../src/slack/thread";

describe("hydrateThread", () => {
  it("flattens replies into '@user: text' lines", async () => {
    const client = { conversationsReplies: vi.fn(async () => ({ messages: [
      { user: "U1", text: "Should we use Postgres?" },
      { user: "U2", text: "Yes, ACID matters." },
    ]}))};
    const text = await hydrateThread(client as any, "C1", "1.0");
    expect(text).toBe("@U1: Should we use Postgres?\n@U2: Yes, ACID matters.");
  });
});
```

```typescript
// test/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config";

describe("loadConfig", () => {
  it("throws when a required env var is missing", () => {
    expect(() => loadConfig({} as any)).toThrow(/SLACK_BOT_TOKEN/);
  });
  it("loads a complete env", () => {
    const cfg = loadConfig({
      SLACK_BOT_TOKEN: "b", SLACK_APP_TOKEN: "a", SLACK_SIGNING_SECRET: "s",
      SLACK_WORKSPACE_TOKEN: "w", LEDGER_CHANNEL_ID: "C", ANTHROPIC_API_KEY: "k",
    } as any);
    expect(cfg.ledgerChannelId).toBe("C");
  });
});
```

- [ ] **Step 2: Run them (FAIL), then implement `src/slack/thread.ts` and `src/config.ts`**

```typescript
// src/slack/thread.ts
export async function hydrateThread(
  client: { conversationsReplies(a: { channel: string; ts: string; include_all_metadata: true }): Promise<{ messages: Array<{ user?: string; text?: string }> }> },
  channelId: string,
  threadTs: string
): Promise<string> {
  const res = await client.conversationsReplies({ channel: channelId, ts: threadTs, include_all_metadata: true });
  return (res.messages ?? [])
    .map((m) => `@${m.user ?? "unknown"}: ${m.text ?? ""}`)
    .join("\n");
}
```

```typescript
// src/config.ts
export interface Config {
  botToken: string; appToken: string; signingSecret: string;
  workspaceToken: string; ledgerChannelId: string; anthropicKey: string;
}

const REQUIRED: Array<[keyof Config, string]> = [
  ["botToken", "SLACK_BOT_TOKEN"], ["appToken", "SLACK_APP_TOKEN"],
  ["signingSecret", "SLACK_SIGNING_SECRET"], ["workspaceToken", "SLACK_WORKSPACE_TOKEN"],
  ["ledgerChannelId", "LEDGER_CHANNEL_ID"], ["anthropicKey", "ANTHROPIC_API_KEY"],
];

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const cfg: any = {};
  for (const [key, envName] of REQUIRED) {
    const v = env[envName];
    if (!v) throw new Error(`Missing required env var: ${envName}`);
    cfg[key] = v;
  }
  return cfg as Config;
}
```

Re-run Step 1 → PASS (both files).

- [ ] **Step 3: Implement `src/app.ts` (integration wiring — no unit test; covered by manual run)**

```typescript
// src/app.ts
import pkg from "@slack/bolt";
const { App } = pkg;
import { WebClient } from "@slack/web-api";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import { makeLedger, type LedgerClient } from "./slack/ledger.js";
import { makeSearch, type RtsClient } from "./rts/search.js";
import { SearchBudget } from "./rts/budget.js";
import { Llm } from "./agent/llm.js";
import { hydrateThread } from "./slack/thread.js";
import { runCapture } from "./agent/capture.js";
import { createBriefCanvas, markCanvasDecided } from "./slack/canvas.js";
import { approvalBlocks, finalDecisionBlocks } from "./slack/blocks.js";
import { consolidate, coldProfile } from "./memory/observer.js";
import { entityIdForChannel, type DecisionRecord } from "./types.js";

const cfg = loadConfig(process.env);
const app = new App({ token: cfg.botToken, appToken: cfg.appToken, signingSecret: cfg.signingSecret, socketMode: true });

const bot = new WebClient(cfg.botToken);          // posting, canvas, ledger writes
const userClient = new WebClient(cfg.workspaceToken); // RTS — search AS the user, workspace token
const anthropic = new Anthropic({ apiKey: cfg.anthropicKey });
const llm = new Llm(anthropic as any);

// Ledger over the bot client's metadata surface.
const ledgerClient: LedgerClient = {
  chatPostMessage: (a) => bot.chat.postMessage(a as any).then(() => {}),
  conversationsHistory: (a) => bot.conversations.history(a as any) as any,
};
const ledger = makeLedger(ledgerClient, cfg.ledgerChannelId);

// In-memory map from decisionId -> the materials needed to finalize. v1: process-local.
const pending = new Map<string, { record: DecisionRecord; canvasId: string; refs: any[]; channelId: string; threadTs: string; brief: any }>();

const nowIso = () => new Date().toISOString();
const newId = () => `d_${Math.random().toString(36).slice(2, 10)}`;

app.shortcut("capture_decision", async ({ shortcut, ack, client }) => {
  await ack();
  const msg = (shortcut as any).message;
  const channelId = (shortcut as any).channel.id;
  const threadTs = msg.thread_ts ?? msg.ts;
  const capturer = (shortcut as any).user.id;

  const threadText = await hydrateThread(
    { conversationsReplies: (x) => bot.conversations.replies(x as any) as any },
    channelId, threadTs);

  // RTS bound to the user (workspace) token.
  const rts: RtsClient = {
    searchContext: (x) => userClient.apiCall("assistant.search.context", x as any) as any,
    searchInfo: () => userClient.apiCall("assistant.search.info", {}) as any,
  };
  const budget = new SearchBudget(6);
  const search = makeSearch(rts, budget);

  const cap = await runCapture({ ledger, llm, search, budget, now: nowIso() },
    { channelId, threadTs, capturer, threadText });

  const canvasId = await createBriefCanvas(
    { canvasesCreate: (a) => bot.apiCall("canvases.create", a as any) as any,
      canvasesEdit: (a) => bot.apiCall("canvases.edit", a as any).then(() => {}) },
    cap.brief, cap.refs, "private"); // default conservative audience for v1

  const id = newId();
  const record: DecisionRecord = {
    recordType: "decision_record", id, title: cap.brief.title, status: "in_review",
    origin: { channelId, threadTs }, capturer, approvers: [],
    decisionText: cap.brief.decisionText, optionsConsidered: cap.brief.optionsConsidered,
    rationale: cap.brief.rationale, owners: cap.brief.proposedOwners.map((o: any) => ({ ...o })),
    entities: cap.resolved.entities, relatedDecisionIds: [],
    contextRefs: cap.refs, canvasId,
  };
  pending.set(id, { record, canvasId, refs: cap.refs, channelId, threadTs, brief: cap.brief });

  await bot.chat.postMessage({
    channel: channelId, thread_ts: threadTs,
    text: `Decision brief drafted: ${cap.brief.title}`,
    blocks: approvalBlocks(id, cap.brief),
  });
});

async function finalize(decisionId: string, approverId: string, status: "decided" | "rejected") {
  const p = pending.get(decisionId);
  if (!p) return;
  const record: DecisionRecord = { ...p.record, status, decidedAt: nowIso(), approvers: [approverId] };

  if (status === "decided") {
    await markCanvasDecided(
      { canvasesCreate: async () => ({ canvas_id: "" }),
        canvasesEdit: (a) => bot.apiCall("canvases.edit", a as any).then(() => {}) },
      p.canvasId, record.decisionText);
    await bot.chat.postMessage({
      channel: p.channelId, thread_ts: p.threadTs,
      text: `Decided: ${record.decisionText}`,
      blocks: finalDecisionBlocks(p.brief, record.owners),
    });
  }

  // Step 10/11: write the decision and run the inline observer to update the profile.
  await ledger.writeDecision(record);
  const entity = record.entities[0] ?? entityIdForChannel(p.channelId);
  const prior = (await ledger.getProfile(entity)) ?? coldProfile(entity, nowIso());
  const newCursorTs = p.threadTs; // delta cursor advances to this capture's anchor
  const profile = await consolidate({
    llm, prior, newDecision: record,
    recentRefs: record.contextRefs.map((r) => ({ permalink: r.permalink, snippet: r.snippet, ts: r.ts })),
    newCursorTs, now: nowIso(),
  });
  await ledger.writeProfile(profile);
  pending.delete(decisionId);
}

app.action("approve", async ({ ack, body, action }) => { await ack(); await finalize((action as any).value, (body as any).user.id, "decided"); });
app.action("reject", async ({ ack, body, action }) => { await ack(); await finalize((action as any).value, (body as any).user.id, "rejected"); });
app.action("revise", async ({ ack, body }) => {
  await ack();
  await bot.chat.postMessage({ channel: (body as any).channel?.id ?? (body as any).user.id, text: "Revise: reply in-thread with what to change, then re-run *Capture decision*." });
});

await app.start();
console.log("⚡ DecisionOps agent running (socket mode)");
```

- [ ] **Step 4: Run the full suite to confirm everything still passes**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all unit tests PASS; type-check clean. (`app.ts` is not unit-tested; it must compile.)

- [ ] **Step 5: Commit**

```bash
git add src/slack/thread.ts src/config.ts src/app.ts test/slack/thread.test.ts test/config.test.ts
git commit -m "feat: thread hydration, config, and Bolt app wiring (shortcut + approval + finalize + observer)"
```

---

### Task 11: Eval harness — logic layer + cold-vs-warm metric

**Files:**
- Create: `eval/fakeSlack.ts`, `eval/harness.test.ts`
- Test: `eval/harness.test.ts` (it IS the eval)

**Interfaces:**
- Consumes: `makeLedger`, `makeSearch`, `SearchBudget`, `runCapture`, `Llm`, `coldProfile`, `consolidate`, types.
- Produces:
  - `makeFakeSlack(): { ledgerClient: LedgerClient; rts: RtsClient; searchCalls: () => number; seedSearchResult(r): void }` — an in-memory Slack with metadata round-trip and a counting RTS.
  - The eval asserts: (a) metadata round-trips a record byte-equivalently; (b) the budget caps RTS at ≤6; (c) a warm capture (profile seeded) spends strictly fewer RTS calls than the cold capture for the same thread; (d) the delta cursor advances after `consolidate`.

- [ ] **Step 1: Implement the fake Slack**

```typescript
// eval/fakeSlack.ts
import type { LedgerClient } from "../src/slack/ledger.js";
import type { RtsClient } from "../src/rts/search.js";

export function makeFakeSlack() {
  const messages: any[] = [];
  let calls = 0;
  let result = [{ permalink: "p", channel_id: "C1", ts: "1.0", text: "ctx", is_private: false }];

  const ledgerClient: LedgerClient = {
    async chatPostMessage(a) { messages.unshift({ metadata: a.metadata }); },
    async conversationsHistory() { return { messages }; },
  };
  const rts: RtsClient = {
    async searchContext() { calls++; return { results: result }; },
    async searchInfo() { return { semantic_search_enabled: false }; },
  };
  return {
    ledgerClient, rts,
    searchCalls: () => calls,
    seedSearchResult(r: typeof result) { result = r; },
    raw: messages,
  };
}
```

- [ ] **Step 2: Write the eval (failing until wired)**

```typescript
// eval/harness.test.ts
import { describe, it, expect, vi } from "vitest";
import { makeFakeSlack } from "./fakeSlack";
import { makeLedger } from "../src/slack/ledger";
import { makeSearch } from "../src/rts/search";
import { SearchBudget } from "../src/rts/budget";
import { runCapture } from "../src/agent/capture";
import { Llm } from "../src/agent/llm";
import { coldProfile, consolidate } from "../src/memory/observer";
import { isDecisionRecord, type DecisionRecord } from "../src/types";

// Scripted LLM: resolve -> (N search turns) -> synthesize. N = openQuestions count.
function scriptedLlm(openQuestions: number) {
  let structuredPhase = 0;
  let remaining = openQuestions;
  const create = vi.fn(async (req: any) => {
    if (req.output_config?.format) {
      structuredPhase++;
      if (structuredPhase === 1) return { content: [{ type: "text", text: JSON.stringify({
        decisionStatement: "Adopt Postgres", options: ["pg"], entities: ["channel:C1"],
        openQuestions: openQuestions ? ["q"] : [], title: "DB" })}]};
      return { content: [{ type: "text", text: JSON.stringify({
        title: "DB", decisionText: "pg", optionsConsidered: ["pg"], rationale: "r",
        proposedOwners: [], openQuestions: [], bodySummary: "b" })}]};
    }
    if (remaining > 0) { remaining--; return { stop_reason: "tool_use", content: [
      { type: "tool_use", id: "t", name: "search", input: { query: "q" } }]}; }
    return { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] };
  });
  return new Llm({ messages: { create } } as any);
}

describe("DecisionOps eval — logic layer", () => {
  it("(a) metadata round-trips a decision record", async () => {
    const fake = makeFakeSlack();
    const ledger = makeLedger(fake.ledgerClient, "CLEDGER");
    const rec: DecisionRecord = {
      recordType: "decision_record", id: "d1", title: "t", status: "decided",
      origin: { channelId: "C1", threadTs: "1.0" }, capturer: "U1", approvers: [],
      decisionText: "x", optionsConsidered: [], rationale: "y", owners: [],
      entities: ["channel:C1"], relatedDecisionIds: [], contextRefs: [],
    };
    await ledger.writeDecision(rec);
    const back = (await ledger.allDecisions())[0];
    expect(back).toEqual(rec);
    expect(isDecisionRecord(back)).toBe(true);
  });

  it("(b) RTS budget caps live calls at <= 6", async () => {
    const fake = makeFakeSlack();
    const budget = new SearchBudget(6);
    const search = makeSearch(fake.rts, budget);
    for (let i = 0; i < 20; i++) await search.run(`q${i}`, {});
    expect(fake.searchCalls()).toBeLessThanOrEqual(6);
  });

  it("(c) warm capture spends strictly fewer RTS calls than cold", async () => {
    // COLD
    const cold = makeFakeSlack();
    const coldLedger = makeLedger(cold.ledgerClient, "CLEDGER");
    const coldBudget = new SearchBudget(6);
    const coldRes = await runCapture(
      { ledger: coldLedger, llm: scriptedLlm(3), search: makeSearch(cold.rts, coldBudget), budget: coldBudget, now: "t" },
      { channelId: "C1", threadTs: "1.0", capturer: "U1", threadText: "..." });

    // WARM
    const warm = makeFakeSlack();
    const warmLedger = makeLedger(warm.ledgerClient, "CLEDGER");
    await warmLedger.writeProfile({ ...coldProfile("channel:C1", "t"),
      static: { summary: "billing", keyPeople: ["U1"], keySystems: ["pg"], decisionNorms: "n", builtAt: "t" } });
    const warmBudget = new SearchBudget(6);
    const warmRes = await runCapture(
      { ledger: warmLedger, llm: scriptedLlm(0), search: makeSearch(warm.rts, warmBudget), budget: warmBudget, now: "t" },
      { channelId: "C1", threadTs: "1.0", capturer: "U1", threadText: "..." });

    expect(warmRes.rtsCalls).toBeLessThan(coldRes.rtsCalls);
    console.log(`cold RTS calls=${coldRes.rtsCalls}  warm RTS calls=${warmRes.rtsCalls}`); // the thesis chart
  });

  it("(d) consolidate advances the delta cursor", async () => {
    const create = vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify({
      static: { summary: "s", keyPeople: [], keySystems: [], decisionNorms: "", builtAt: "t" },
      dynamic: { inFlightDecisions: [], recentThreads: [], openQuestions: [], searchCursor: { untilTs: "x" }, refreshedAt: "t" },
    })}]}));
    const llm = new Llm({ messages: { create } } as any);
    const prior = coldProfile("channel:C1", "t0");
    const rec: DecisionRecord = {
      recordType: "decision_record", id: "d", title: "t", status: "decided",
      origin: { channelId: "C1", threadTs: "1.0" }, capturer: "U1", approvers: [],
      decisionText: "x", optionsConsidered: [], rationale: "r", owners: [],
      entities: ["channel:C1"], relatedDecisionIds: [], contextRefs: [],
    };
    const next = await consolidate({ llm, prior, newDecision: rec, recentRefs: [], newCursorTs: "1800", now: "t1" });
    expect(prior.dynamic.searchCursor.untilTs).toBe("0");
    expect(next.dynamic.searchCursor.untilTs).toBe("1800");
  });
});
```

- [ ] **Step 3: Run the eval (PASS)**

Run: `npx vitest run eval/harness.test.ts`
Expected: PASS (4 assertions). The `console.log` in (c) prints the cold-vs-warm RTS counts — this is the judge-facing artifact in miniature.

- [ ] **Step 4: Run the entire suite + type-check**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS, type-check clean.

- [ ] **Step 5: Commit**

```bash
git add eval/fakeSlack.ts eval/harness.test.ts
git commit -m "test: eval harness — metadata round-trip, budget cap, cold-vs-warm RTS, cursor advance"
```

---

## Out of scope for v1 (do NOT build here)

These are spec §10 phase-2 items — leave them out of this plan:
- Async/event-driven observer watching opted-in channels (v1's observer runs inline on finalize).
- Proactive nudge / decision detection in opted-in channels.
- Slash-command and assistant-container surfaces.
- The Layer-2 retrieval-quality eval against a seeded *real* workspace (this plan ships the **logic-layer** eval + the cold-vs-warm metric on fakes; the seeded-workspace eval and the import/indexing-probe scripts are a follow-up once the app runs end-to-end in a real workspace).
- Marketplace submission.

## Verification (manual, after Task 11)

1. Create an internal Slack app, enable Socket Mode, add a **message shortcut** with callback id `capture_decision`. Scopes: `chat:write`, `canvases:write`, `channels:history`/`groups:history`, `conversations.replies`, plus the RTS `search:read.*` scopes on the user token.
2. Create a private channel, invite the bot, set `LEDGER_CHANNEL_ID`.
3. `npm install && npm run dev`. In a test channel, run **Capture decision** on a message. Confirm: a Canvas brief appears, an approval card posts in-thread, Approve writes a `decisionops_record` to the Ledger channel and a `decisionops_profile`, and a *second* capture in the same channel logs fewer RTS calls.

## Execution Handoff (added below after self-review)
