import type { ContextRef, Visibility } from "../types.js";
import type { SearchBudget } from "./budget.js";

export interface RtsClient {
  searchContext(a: {
    query: string; after?: string;
    disable_semantic_search?: boolean; action_token?: string;
  }): Promise<{
    results: Array<{ permalink: string; channel_id: string; ts: string; text: string; is_private?: boolean }>;
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
      return (res.results ?? []).map((r): ContextRef => ({
        permalink: r.permalink,
        channelId: r.channel_id,
        ts: r.ts,
        snippet: (r.text ?? "").slice(0, SNIPPET_MAX),
        visibility: (r.is_private ? "private" : "public") as Visibility,
      }));
    },
  };
}
