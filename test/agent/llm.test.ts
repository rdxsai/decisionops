// test/agent/llm.test.ts
import { describe, it, expect, vi } from "vitest";
import { Llm, cachedSystem, dynamicSystemMessage, type RawAnthropic } from "../../src/agent/llm";

describe("cachedSystem", () => {
  it("bundles instructions + static profile under one cache breakpoint on the last block", () => {
    const blocks = cachedSystem("INSTR", "PROFILE");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1].text).toContain("PROFILE");
  });
});

describe("dynamicSystemMessage", () => {
  it("produces a role:system message (not a top-level system edit)", () => {
    expect(dynamicSystemMessage("DYN")).toEqual({ role: "system", content: "DYN" });
  });
});

describe("Llm.structured", () => {
  it("requests json_schema output and parses the first text block", async () => {
    const create = vi.fn(async () => ({ content: [{ type: "text", text: '{"ok":true}' }] }));
    const llm = new Llm({ messages: { create } } as RawAnthropic);
    const out = await llm.structured<{ ok: boolean }>({ system: cachedSystem("i", "p"), messages: [], schema: { type: "object" } });
    expect(out.ok).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "claude-opus-4-8",
      output_config: expect.objectContaining({ format: expect.objectContaining({ type: "json_schema" }) }),
    }));
  });
});

describe("Llm.toolLoop", () => {
  it("executes tool calls then returns final text, capped at maxIterations", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ stop_reason: "tool_use", content: [
        { type: "tool_use", id: "t1", name: "search", input: { query: "q" } },
      ]})
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "done" }] });
    const onToolUse = vi.fn(async () => "RESULT");
    const llm = new Llm({ messages: { create } } as RawAnthropic);
    const text = await llm.toolLoop({
      system: cachedSystem("i", "p"), messages: [{ role: "user", content: "go" }],
      tools: [{ name: "search" }], maxIterations: 6, onToolUse,
    });
    expect(text).toBe("done");
    expect(onToolUse).toHaveBeenCalledWith("search", { query: "q" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("stops at maxIterations even if the model keeps calling tools", async () => {
    const create = vi.fn(async () => ({ stop_reason: "tool_use", content: [
      { type: "tool_use", id: "t", name: "search", input: {} },
    ]}));
    const llm = new Llm({ messages: { create } } as RawAnthropic);
    const text = await llm.toolLoop({
      system: cachedSystem("i", "p"), messages: [{ role: "user", content: "go" }],
      tools: [{ name: "search" }], maxIterations: 3, onToolUse: async () => "R",
    });
    expect(create).toHaveBeenCalledTimes(3);
    expect(typeof text).toBe("string");
  });
});
