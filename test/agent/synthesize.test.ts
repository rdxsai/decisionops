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
