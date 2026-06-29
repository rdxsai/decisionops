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
