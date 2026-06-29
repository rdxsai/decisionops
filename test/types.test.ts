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
