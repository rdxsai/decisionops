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
