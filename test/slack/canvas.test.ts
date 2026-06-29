import { describe, it, expect, vi } from "vitest";
import { renderBriefMarkdown, createBriefCanvas, markCanvasDecided } from "../../src/slack/canvas";
import type { Brief } from "../../src/agent/synthesize";

const brief: Brief = {
  title: "DB choice", decisionText: "Use Postgres", optionsConsidered: ["Postgres", "Dynamo"],
  rationale: "ACID", proposedOwners: [{ userId: "U1", task: "migrate" }], openQuestions: ["dual-write?"],
  bodySummary: "We chose Postgres.",
};

describe("canvas", () => {
  it("renders markdown with decision, options, and an audience-gated source that hides private snippets", () => {
    const md = renderBriefMarkdown(brief, [
      { permalink: "pub", channelId: "C1", ts: "1", snippet: "public detail", visibility: "public" },
      { permalink: "priv", channelId: "C2", ts: "2", snippet: "secret detail", visibility: "private" },
    ], "public");
    expect(md).toContain("Use Postgres");
    expect(md).toContain("public detail");
    expect(md).not.toContain("secret detail"); // private ref is link-only for a public brief
    expect(md).toContain("priv");              // but the link is present
  });

  it("creates a canvas and returns the id", async () => {
    const client = { canvasesCreate: vi.fn(async () => ({ canvas_id: "F123" })), canvasesEdit: vi.fn() };
    const id = await createBriefCanvas(client as any, brief, [], "public");
    expect(id).toBe("F123");
  });

  it("marks the canvas decided via an edit", async () => {
    const client = { canvasesCreate: vi.fn(), canvasesEdit: vi.fn(async () => {}) };
    await markCanvasDecided(client as any, "F123", "Use Postgres");
    expect(client.canvasesEdit).toHaveBeenCalledWith(expect.objectContaining({ canvas_id: "F123" }));
  });
});
