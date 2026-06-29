import type { Brief } from "../agent/synthesize.js";

export function approvalBlocks(decisionId: string, brief: Brief): any[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `*Decision brief:* ${brief.title}\n${brief.bodySummary}` } },
    { type: "actions", elements: [
      { type: "button", action_id: "approve", style: "primary", text: { type: "plain_text", text: "Approve" }, value: decisionId },
      { type: "button", action_id: "revise", text: { type: "plain_text", text: "Revise" }, value: decisionId },
      { type: "button", action_id: "reject", style: "danger", text: { type: "plain_text", text: "Reject" }, value: decisionId },
    ]},
  ];
}

export function finalDecisionBlocks(brief: Brief, owners: { userId: string; task: string }[]): any[] {
  const ownerLines = owners.length
    ? owners.map((o) => `• <@${o.userId}> — ${o.task}`).join("\n")
    : "_no follow-up owners_";
  return [
    { type: "section", text: { type: "mrkdwn", text: `✅ *Decided:* ${brief.decisionText}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Follow-ups:*\n${ownerLines}` } },
  ];
}
