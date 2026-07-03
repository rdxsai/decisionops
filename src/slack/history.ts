import type { ChannelMessage } from "../types.js";

export interface HistoryClient {
  conversationsHistory(a: {
    channel: string; oldest?: string; cursor?: string; limit?: number;
  }): Promise<{
    messages: Array<{ ts: string; user?: string; text?: string; subtype?: string }>;
    response_metadata?: { next_cursor?: string };
  }>;
}

export interface HistoryReader {
  readSince(channelId: string, afterTs: string): Promise<ChannelMessage[]>;
}

const numTs = (ts: string): number => Number(ts) || 0;

// Non-content system/membership/meta events Slack posts into a channel. These are not
// conversation and must not count toward ripeness, enter the fold prompt, or become
// provenance. Denylist (not "no subtype at all") so legitimate content keeps flowing —
// notably `bot_message` (integrations posting real context, and our own seeded threads).
const SYSTEM_SUBTYPES = new Set([
  "channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name",
  "channel_archive", "channel_unarchive",
  "group_join", "group_leave", "group_topic", "group_purpose", "group_name",
  "group_archive", "group_unarchive",
  "pinned_item", "unpinned_item", "bot_add", "bot_remove",
]);

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
          if (m.subtype && SYSTEM_SUBTYPES.has(m.subtype)) continue; // skip non-content system events
          // conversations.history returns newest-first; keep only strictly after the cursor.
          if (numTs(m.ts) > numTs(afterTs)) out.push({ ts: m.ts, user: m.user ?? "", text: m.text ?? "" });
        }
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return out; // newest-first
    },
  };
}
