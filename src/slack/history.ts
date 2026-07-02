import type { ChannelMessage } from "../types.js";

export interface HistoryClient {
  conversationsHistory(a: {
    channel: string; oldest?: string; cursor?: string; limit?: number;
  }): Promise<{
    messages: Array<{ ts: string; user?: string; text?: string }>;
    response_metadata?: { next_cursor?: string };
  }>;
}

export interface HistoryReader {
  readSince(channelId: string, afterTs: string): Promise<ChannelMessage[]>;
}

const numTs = (ts: string): number => Number(ts) || 0;

export function makeHistory(client: HistoryClient): HistoryReader {
  return {
    async readSince(channelId, afterTs) {
      const out: ChannelMessage[] = [];
      let cursor: string | undefined;
      do {
        const res = await client.conversationsHistory({
          channel: channelId,
          oldest: afterTs === "0" ? undefined : afterTs, // "0" = cold => all history
          cursor, limit: 200,
        });
        for (const m of res.messages ?? []) {
          // conversations.history returns newest-first; keep only strictly after the cursor.
          if (numTs(m.ts) > numTs(afterTs)) out.push({ ts: m.ts, user: m.user ?? "", text: m.text ?? "" });
        }
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return out; // newest-first
    },
  };
}
