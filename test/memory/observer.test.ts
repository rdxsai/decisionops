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
