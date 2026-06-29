// test/slack/thread.test.ts
import { describe, it, expect, vi } from "vitest";
import { hydrateThread } from "../../src/slack/thread";

describe("hydrateThread", () => {
  it("flattens replies into '@user: text' lines", async () => {
    const client = { conversationsReplies: vi.fn(async () => ({ messages: [
      { user: "U1", text: "Should we use Postgres?" },
      { user: "U2", text: "Yes, ACID matters." },
    ]}))};
    const text = await hydrateThread(client as any, "C1", "1.0");
    expect(text).toBe("@U1: Should we use Postgres?\n@U2: Yes, ACID matters.");
  });
});
