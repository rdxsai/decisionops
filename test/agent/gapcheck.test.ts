// test/agent/gapcheck.test.ts
import { describe, it, expect, vi } from "vitest";
import { gatherContext } from "../../src/agent/gapcheck";
import { Llm } from "../../src/agent/llm";
import { makeSearch } from "../../src/rts/search";
import { SearchBudget } from "../../src/rts/budget";

describe("gatherContext", () => {
  it("runs the bounded search tool loop and accumulates ContextRefs", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ stop_reason: "tool_use", content: [
        { type: "tool_use", id: "t1", name: "search", input: { query: "postgres decision" } },
      ]})
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "enough" }] });
    const llm = new Llm({ messages: { create } } as any);
    const rts = {
      searchContext: vi.fn(async () => ({ results: { messages: [{ permalink: "p", channel_id: "C1", ts: "1.0", text: "ctx", is_private: false }] } })),
      searchInfo: vi.fn(async () => ({ semantic_search_enabled: false })),
    };
    const search = makeSearch(rts, new SearchBudget(6));
    const refs = await gatherContext({
      llm, search, staticProfile: "S", dynamicProfile: "D", afterTs: "0",
      resolved: { decisionStatement: "x", options: [], entities: [], openQuestions: ["q"], title: "t" },
    });
    expect(refs.map((r) => r.permalink)).toEqual(["p"]);
    expect(rts.searchContext).toHaveBeenCalledTimes(1);
    // Regression guard: first message must not be a system message (API rejects role:"system" at messages[0])
    const firstCall = (create.mock.calls as any[][])[0]![0] as { messages: Array<{ role: string }> };
    expect(firstCall.messages[0].role).not.toBe("system");
    // afterTs forwarded to RTS as `after`
    expect(rts.searchContext).toHaveBeenCalledWith(expect.objectContaining({ after: "0" }));
  });
});
