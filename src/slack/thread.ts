export async function hydrateThread(
  client: { conversationsReplies(a: { channel: string; ts: string; include_all_metadata: true }): Promise<{ messages: Array<{ user?: string; text?: string }> }> },
  channelId: string,
  threadTs: string
): Promise<string> {
  const res = await client.conversationsReplies({ channel: channelId, ts: threadTs, include_all_metadata: true });
  return (res.messages ?? [])
    .map((m) => `@${m.user ?? "unknown"}: ${m.text ?? ""}`)
    .join("\n");
}
