import type { Brief } from "../agent/synthesize.js";
import type { ContextRef, Visibility } from "../types.js";
import { scopeRefs, renderRef } from "../permissions/scope.js";

export interface CanvasClient {
  canvasesCreate(a: { title: string; document_content: { type: "markdown"; markdown: string } }): Promise<{ canvas_id: string }>;
  canvasesEdit(a: { canvas_id: string; changes: any[] }): Promise<void>;
}

export function renderBriefMarkdown(brief: Brief, refs: ContextRef[], audience: Visibility): string {
  const { inline, linkOnly } = scopeRefs(refs, audience);
  const sources = [...inline.map((r) => renderRef(r, true)), ...linkOnly.map((r) => renderRef(r, false))];
  return [
    `# ${brief.title}`,
    `**Status:** Draft`,
    ``,
    `## Decision`,
    brief.decisionText,
    ``,
    `## Options considered`,
    ...brief.optionsConsidered.map((o) => `- ${o}`),
    ``,
    `## Rationale`,
    brief.rationale,
    ``,
    `## Proposed owners`,
    ...(brief.proposedOwners.length ? brief.proposedOwners.map((o) => `- <@${o.userId}> — ${o.task}`) : ["- _none yet_"]),
    ``,
    `## Open questions`,
    ...(brief.openQuestions.length ? brief.openQuestions.map((q) => `- ${q}`) : ["- _none_"]),
    ``,
    `## Sources`,
    ...(sources.length ? sources : ["- _none_"]),
  ].join("\n");
}

export async function createBriefCanvas(client: CanvasClient, brief: Brief, refs: ContextRef[], audience: Visibility): Promise<string> {
  const res = await client.canvasesCreate({
    title: brief.title,
    document_content: { type: "markdown", markdown: renderBriefMarkdown(brief, refs, audience) },
  });
  return res.canvas_id;
}

export async function markCanvasDecided(client: CanvasClient, canvasId: string, decisionText: string): Promise<void> {
  // Canvas is write-only; append a decided banner. (replace section by id is also valid;
  // append keeps v1 simple and avoids a sections.lookup round-trip.)
  await client.canvasesEdit({
    canvas_id: canvasId,
    changes: [{ operation: "insert_at_start", document_content: { type: "markdown", markdown: `> ✅ **DECIDED** — ${decisionText}\n\n` } }],
  });
}
