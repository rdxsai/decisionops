import { describe, it, expect, vi } from "vitest";
import { makeSearch, type RtsClient } from "../../src/rts/search";
import { SearchBudget } from "../../src/rts/budget";

function fakeRts(over: Partial<RtsClient> = {}): RtsClient {
  return {
    searchContext: vi.fn(async () => ({
      results: { messages: [{ permalink: "p", channel_id: "C1", ts: "1.0", text: "hello world here", is_private: true }] },
    })),
    searchInfo: vi.fn(async () => ({ semantic_search_enabled: false })),
    ...over,
  };
}

describe("Search", () => {
  it("maps results to provenance ContextRefs with truncated snippet + visibility", async () => {
    const rts = fakeRts();
    const search = makeSearch(rts, new SearchBudget(6));
    const refs = await search.run("why did we pick postgres", { afterTs: "1700" });
    expect(refs[0]).toMatchObject({ permalink: "p", channelId: "C1", ts: "1.0", visibility: "private" });
    expect(refs[0].snippet.length).toBeLessThanOrEqual(160);
    expect(rts.searchContext).toHaveBeenCalledWith(expect.objectContaining({ after: "1700" }));
  });

  it("returns [] without calling RTS once the budget is exhausted", async () => {
    const rts = fakeRts();
    const budget = new SearchBudget(1);
    const search = makeSearch(rts, budget);
    await search.run("q1", {});
    const refs = await search.run("q2", {});
    expect(refs).toEqual([]);
    expect(rts.searchContext).toHaveBeenCalledTimes(1);
  });

  it("disables semantic search when AI search is unavailable", async () => {
    const rts = fakeRts({ searchInfo: vi.fn(async () => ({ semantic_search_enabled: false })) });
    const search = makeSearch(rts, new SearchBudget(6));
    await search.run("q?", {});
    expect(rts.searchContext).toHaveBeenCalledWith(expect.objectContaining({ disable_semantic_search: true }));
  });
});
