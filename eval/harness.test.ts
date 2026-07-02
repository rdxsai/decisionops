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
import { makeRegistry } from "../src/slack/registry";
import { makeHistory } from "../src/slack/history";
import { runObserverTick } from "../src/observer/loop";

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

    expect(coldRes.rtsCalls).toBeGreaterThan(0);
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
      botMemberships: async () => obs.memberships(), threshold: 8, recentK: 3, foldWindow: 50, maxFolds: 3, now: () => "t",
      ledgerChannelId: "CLEDGER" });

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
});
