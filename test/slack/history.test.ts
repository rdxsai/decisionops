import { describe, it, expect, vi } from "vitest";
import { makeHistory, type HistoryClient } from "../../src/slack/history";

describe("HistoryReader", () => {
  it("returns only messages strictly newer than the cursor and passes oldest", async () => {
    const client: HistoryClient = {
      conversationsHistory: vi.fn(async () => ({
        messages: [
          { ts: "300", user: "U1", text: "new" },
          { ts: "200", user: "U2", text: "at cursor" },
          { ts: "100", user: "U3", text: "old" },
        ],
      })),
    };
    const msgs = await makeHistory(client).readSince("C1", "200");
    expect(msgs.map((m) => m.ts)).toEqual(["300"]);
    expect(client.conversationsHistory).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1", oldest: "200" }));
  });

  it("pages until next_cursor is exhausted", async () => {
    const page = vi.fn()
      .mockResolvedValueOnce({ messages: [{ ts: "300", user: "U1", text: "a" }], response_metadata: { next_cursor: "X" } })
      .mockResolvedValueOnce({ messages: [{ ts: "250", user: "U2", text: "b" }] });
    const msgs = await makeHistory({ conversationsHistory: page } as any).readSince("C1", "0");
    expect(msgs.map((m) => m.ts)).toEqual(["300", "250"]);
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("passes no oldest for a cold cursor of 0", async () => {
    const client: HistoryClient = { conversationsHistory: vi.fn(async () => ({ messages: [] })) };
    await makeHistory(client).readSince("C1", "0");
    expect(client.conversationsHistory).toHaveBeenCalledWith(expect.objectContaining({ oldest: undefined }));
  });

  it("drops non-content system messages (channel_join etc.) but keeps real + bot content", async () => {
    const client: HistoryClient = {
      conversationsHistory: vi.fn(async () => ({
        messages: [
          { ts: "500", user: "U1", text: "real decision talk" },
          { ts: "400", user: "U2", subtype: "channel_join", text: "U2 has joined the channel" },
          { ts: "300", user: "U3", subtype: "channel_topic", text: "set the channel topic" },
          { ts: "200", user: "BOT", subtype: "bot_message", text: "integration posted context" },
        ],
      })),
    };
    const msgs = await makeHistory(client).readSince("C1", "0");
    // channel_join / channel_topic dropped; real user message + bot content kept.
    expect(msgs.map((m) => m.ts)).toEqual(["500", "200"]);
    expect(msgs.map((m) => m.text)).toEqual(["real decision talk", "integration posted context"]);
  });
});
