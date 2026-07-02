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
function scriptedLlm(searchCalls: number, entities: string[] = ["channel:C1"]) {
  let phase = 0;
  const create = vi.fn(async (req: any) => {
    // resolve (structured) -> gapcheck (tool loop) -> synthesize (structured)
    if (req.output_config?.format) {
      phase++;
      if (phase === 1) return { content: [{ type: "text", text: JSON.stringify({
        decisionStatement: "Adopt Postgres", options: ["pg", "dynamo"],
        entities, openQuestions: searchCalls ? ["q"] : [], title: "DB",
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
  searchContext: vi.fn(async () => ({ results: { messages: [{ permalink: "p", channel_id: "C1", ts: "1.0", text: "c", is_private: false }] } })),
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

  it("keys the profile on the channel seed, not a person, when resolve lists a user id first", async () => {
    const client = fakeLedgerClient();
    const ledger = makeLedger(client as any, "CLEDGER");
    // The warm profile lives under the CHANNEL entity.
    await ledger.writeProfile({ ...coldProfile("channel:C1", "t"),
      static: { summary: "billing", keyPeople: ["U1"], keySystems: ["pg"], decisionNorms: "n", builtAt: "t" } });

    // Resolver lists a bare user id first — the live-run failure mode that fragmented
    // warm-start onto a person (U0BD…) instead of the channel.
    const budget = new SearchBudget(6);
    const res = await runCapture(
      { ledger, llm: scriptedLlm(0, ["U0BD123456", "channel:C1"]),
        search: makeSearch(rts() as any, budget), budget, now: "t" },
      { channelId: "C1", threadTs: "1.0", capturer: "U1", threadText: "..." });

    expect(res.profile.entityId).toBe("channel:C1");
    expect(res.profile.static.summary).toBe("billing"); // warm-started, not a cold person-keyed profile
  });

  it("round-trips the profile key: what capture #1 keys on is what a warm capture #2 reads", async () => {
    // Pins the read == write invariant. Finalize must persist the profile under the key
    // runCapture chose (`profile.entityId`); if read and write disagree, warm-start
    // silently misses on the next capture (the person-first regression the reviewer caught).
    const client = fakeLedgerClient();
    const ledger = makeLedger(client as any, "CLEDGER");

    // COLD capture #1 — resolver lists a person first; searches happen.
    const b1 = new SearchBudget(6);
    const cap1 = await runCapture(
      { ledger, llm: scriptedLlm(2, ["U0BD123456", "channel:C1"]),
        search: makeSearch(rts() as any, b1), budget: b1, now: "t" },
      { channelId: "C1", threadTs: "1.0", capturer: "U1", threadText: "..." });
    expect(cap1.rtsCalls).toBeGreaterThan(0);

    // Persist under EXACTLY the key the capture chose — i.e. what app.ts finalize does.
    await ledger.writeProfile({ ...coldProfile(cap1.profile.entityId, "t"),
      static: { summary: "billing", keyPeople: [], keySystems: [], decisionNorms: "", builtAt: "t" } });

    // WARM capture #2 — same channel, person still listed first — must find that profile.
    const b2 = new SearchBudget(6);
    const cap2 = await runCapture(
      { ledger, llm: scriptedLlm(0, ["U0BD123456", "channel:C1"]),
        search: makeSearch(rts() as any, b2), budget: b2, now: "t" },
      { channelId: "C1", threadTs: "2.0", capturer: "U1", threadText: "..." });
    expect(cap2.profile.static.summary).toBe("billing"); // warm-started, not cold again
    expect(cap2.rtsCalls).toBe(0);
  });
});
