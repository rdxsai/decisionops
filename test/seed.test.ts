import { describe, it, expect } from "vitest";
import { seedThreads } from "../src/seed";

describe("seedThreads", () => {
  it("produces several decision threads, each with a parent and at least two replies", () => {
    const threads = seedThreads();
    expect(threads.length).toBeGreaterThanOrEqual(3);
    for (const t of threads) {
      expect(t.text.length).toBeGreaterThan(0);
      expect(t.replies.length).toBeGreaterThanOrEqual(2);
      expect(t.replies.every((r) => r.length > 0)).toBe(true);
    }
  });
});
