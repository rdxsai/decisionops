import type { ContextRef, Visibility } from "../types.js";
import type { SearchBudget } from "./budget.js";

export interface RtsClient {
  searchContext(a: {
    query: string; after?: string;
    disable_semantic_search?: boolean; action_token?: string;
  }): Promise<{
    // Real assistant.search.context groups results by content type: { messages, files, channels, users }.
    results?: { messages?: Array<Record<string, any>> };
  }>;
  searchInfo(): Promise<{ semantic_search_enabled: boolean }>;
}

export interface Search {
  semanticAvailable(): Promise<boolean>;
  run(query: string, opts: { afterTs?: string }): Promise<ContextRef[]>;
}

const SNIPPET_MAX = 160;

export function makeSearch(client: RtsClient, budget: SearchBudget): Search {
  let semantic: boolean | undefined;
  async function semanticAvailable() {
    if (semantic === undefined) semantic = (await client.searchInfo()).semantic_search_enabled;
    return semantic;
  }
  return {
    semanticAvailable,
    async run(query, opts) {
      if (!budget.tryConsume()) return [];
      const useSemantic = await semanticAvailable();
      const res = await client.searchContext({
        query,
        after: opts.afterTs,
        disable_semantic_search: !useSemantic,
      });
      // Defensive field mapping — message item field names vary; never crash on missing fields.
      return (res.results?.messages ?? []).map((r): ContextRef => ({
        permalink: r.permalink ?? "",
        channelId: r.channel_id ?? r.channel?.id ?? "",
        ts: r.message_ts ?? r.ts ?? "",
        snippet: String(r.content ?? r.text ?? "").slice(0, SNIPPET_MAX),
        visibility: (r.is_private ? "private" : "public") as Visibility,
      }));
    },
  };
}
