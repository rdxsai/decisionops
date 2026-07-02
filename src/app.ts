// src/app.ts
import "dotenv/config";
import { App } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import { makeLedger, type LedgerClient } from "./slack/ledger.js";
import { makeSearch, type RtsClient } from "./rts/search.js";
import { SearchBudget } from "./rts/budget.js";
import { Llm } from "./agent/llm.js";
import { hydrateThread } from "./slack/thread.js";
import { runCapture } from "./agent/capture.js";
import { createBriefCanvas, markCanvasDecided } from "./slack/canvas.js";
import { approvalBlocks, finalDecisionBlocks } from "./slack/blocks.js";
import { consolidate, coldProfile } from "./memory/observer.js";
import type { DecisionRecord } from "./types.js";

const cfg = loadConfig(process.env);
const app = new App({ token: cfg.botToken, appToken: cfg.appToken, signingSecret: cfg.signingSecret, socketMode: true });

const bot = new WebClient(cfg.botToken);          // posting, canvas, ledger writes
const userClient = new WebClient(cfg.workspaceToken); // RTS — search AS the user, workspace token
const anthropic = new Anthropic({ apiKey: cfg.anthropicKey });
const llm = new Llm(anthropic as any);

// Ledger over the bot client's metadata surface.
const ledgerClient: LedgerClient = {
  chatPostMessage: (a) => bot.chat.postMessage(a as any).then(() => {}),
  conversationsHistory: (a) => bot.conversations.history(a as any) as any,
};
const ledger = makeLedger(ledgerClient, cfg.ledgerChannelId);

// In-memory map from decisionId -> the materials needed to finalize. v1: process-local.
const pending = new Map<string, { record: DecisionRecord; primaryEntity: string; canvasId: string; refs: any[]; channelId: string; threadTs: string; brief: any }>();

const nowIso = () => new Date().toISOString();
const newId = () => `d_${Math.random().toString(36).slice(2, 10)}`;

app.shortcut("capture_decision", async ({ shortcut, ack, client }: { shortcut: any; ack: any; client: any }) => {
  await ack();
  const msg = (shortcut as any).message;
  const channelId = (shortcut as any).channel.id;
  const threadTs = msg.thread_ts ?? msg.ts;
  const capturer = (shortcut as any).user.id;

  const threadText = await hydrateThread(
    { conversationsReplies: (x) => bot.conversations.replies(x as any) as any },
    channelId, threadTs);

  // RTS bound to the user (workspace) token.
  const rts: RtsClient = {
    searchContext: (x) => userClient.apiCall("assistant.search.context", x as any) as any,
    searchInfo: () => userClient.apiCall("assistant.search.info", {}) as any,
  };
  const budget = new SearchBudget(6);
  const search = makeSearch(rts, budget);

  const cap = await runCapture({ ledger, llm, search, budget, now: nowIso() },
    { channelId, threadTs, capturer, threadText });

  const canvasId = await createBriefCanvas(
    { canvasesCreate: (a) => bot.apiCall("canvases.create", a as any) as any,
      canvasesEdit: (a) => bot.apiCall("canvases.edit", a as any).then(() => {}) },
    cap.brief, cap.refs, "private"); // default conservative audience for v1

  const id = newId();
  const record: DecisionRecord = {
    recordType: "decision_record", id, title: cap.brief.title, status: "in_review",
    origin: { channelId, threadTs }, capturer, approvers: [],
    decisionText: cap.brief.decisionText, optionsConsidered: cap.brief.optionsConsidered,
    rationale: cap.brief.rationale, owners: cap.brief.proposedOwners.map((o: any) => ({ ...o })),
    entities: cap.resolved.entities, relatedDecisionIds: [],
    contextRefs: cap.refs, canvasId,
  };
  pending.set(id, { record, primaryEntity: cap.profile.entityId, canvasId, refs: cap.refs, channelId, threadTs, brief: cap.brief });

  await bot.chat.postMessage({
    channel: channelId, thread_ts: threadTs,
    text: `Decision brief drafted: ${cap.brief.title}`,
    blocks: approvalBlocks(id, cap.brief),
  });
});

async function finalize(decisionId: string, approverId: string, status: "decided" | "rejected") {
  const p = pending.get(decisionId);
  if (!p) return;
  pending.delete(decisionId); // claim immediately — double-clicks find nothing and no-op
  const record: DecisionRecord = { ...p.record, status, decidedAt: nowIso(), approvers: [approverId] };

  if (status === "decided") {
    await markCanvasDecided(
      { canvasesCreate: async () => ({ canvas_id: "" }),
        canvasesEdit: (a) => bot.apiCall("canvases.edit", a as any).then(() => {}) },
      p.canvasId, record.decisionText);
    await bot.chat.postMessage({
      channel: p.channelId, thread_ts: p.threadTs,
      text: `Decided: ${record.decisionText}`,
      blocks: finalDecisionBlocks(p.brief, record.owners),
    });
  }

  // Step 10/11: write the decision record for all statuses (audit trail).
  await ledger.writeDecision(record);
  // Only consolidate into the entity profile for approved decisions.
  if (status === "decided") {
    // Reuse the exact key the capture chose for recall, so the profile is written under
    // the same entity it will be read back under next time (read == write; no warm-start miss).
    const entity = p.primaryEntity;
    const prior = (await ledger.getProfile(entity)) ?? coldProfile(entity, nowIso());
    const newCursorTs = p.threadTs; // delta cursor advances to this capture's anchor
    const profile = await consolidate({
      llm, prior, newDecision: record,
      recentRefs: record.contextRefs.map((r) => ({ permalink: r.permalink, snippet: r.snippet, ts: r.ts })),
      newCursorTs, now: nowIso(),
    });
    await ledger.writeProfile(profile);
  }
}

app.action("approve", async ({ ack, body, action }: { ack: any; body: any; action: any }) => { await ack(); await finalize((action as any).value, (body as any).user.id, "decided"); });
app.action("reject", async ({ ack, body, action }: { ack: any; body: any; action: any }) => { await ack(); await finalize((action as any).value, (body as any).user.id, "rejected"); });
app.action("revise", async ({ ack, body }: { ack: any; body: any }) => {
  await ack();
  await bot.chat.postMessage({ channel: (body as any).channel?.id ?? (body as any).user.id, text: "Revise: reply in-thread with what to change, then re-run *Capture decision*." });
});

await app.start();
console.log("⚡ DecisionOps agent running (socket mode)");
