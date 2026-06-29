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
