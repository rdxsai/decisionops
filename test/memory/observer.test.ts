// test/memory/observer.test.ts
import { describe, it, expect, vi } from "vitest";
import { coldProfile, consolidate, isRipe, observeActivity } from "../../src/memory/observer";
import { Llm } from "../../src/agent/llm";
import type { DecisionRecord, EntityProfile } from "../../src/types";

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
