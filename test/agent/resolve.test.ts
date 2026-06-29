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
