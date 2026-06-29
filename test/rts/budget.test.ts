import { describe, it, expect } from "vitest";
import { SearchBudget } from "../../src/rts/budget";

describe("SearchBudget", () => {
  it("allows up to max consumes then blocks", () => {
    const b = new SearchBudget(2);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false);
    expect(b.spent()).toBe(2);
    expect(b.remaining()).toBe(0);
  });
});
