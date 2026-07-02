import { CHANNEL_REGISTRATION_EVENT_TYPE, type ChannelRegistration } from "../types.js";
import type { LedgerClient } from "./ledger.js";

export interface Registry {
  listActive(): Promise<string[]>;
  register(channelId: string): Promise<void>;
  deactivate(channelId: string): Promise<void>;
}

export function makeRegistry(client: LedgerClient, ledgerChannelId: string, now: () => string): Registry {
  async function readAll(): Promise<ChannelRegistration[]> {
    const out: ChannelRegistration[] = [];
    let cursor: string | undefined;
    do {
      const res = await client.conversationsHistory({ channel: ledgerChannelId, include_all_metadata: true, cursor });
      for (const m of res.messages ?? []) {
        if (m.metadata?.event_type === CHANNEL_REGISTRATION_EVENT_TYPE) {
          out.push(m.metadata.event_payload as ChannelRegistration);
        }
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out; // newest-first
  }

  function write(reg: ChannelRegistration): Promise<void> {
    return client.chatPostMessage({
      channel: ledgerChannelId,
      text: `Registration: ${reg.channelId} [${reg.active ? "active" : "inactive"}]`,
      metadata: { event_type: CHANNEL_REGISTRATION_EVENT_TYPE, event_payload: reg },
    });
  }

  return {
    async listActive() {
      const seen = new Set<string>();
      const active: string[] = [];
      for (const r of await readAll()) { // newest-first => first seen is the latest state
        if (seen.has(r.channelId)) continue;
        seen.add(r.channelId);
        if (r.active) active.push(r.channelId);
      }
      return active;
    },
    register: (channelId) => write({ recordType: "channel_registration", channelId, active: true, registeredAt: now() }),
    deactivate: (channelId) => write({ recordType: "channel_registration", channelId, active: false, registeredAt: now() }),
  };
}

export async function reconcileRegistry(
  registry: Registry,
  botMemberships: string[],
): Promise<{ added: string[]; removed: string[]; active: string[] }> {
  const current = await registry.listActive();
  const currentSet = new Set(current);
  const memberSet = new Set(botMemberships);
  const added: string[] = [];
  const removed: string[] = [];
  for (const id of botMemberships) if (!currentSet.has(id)) { await registry.register(id); added.push(id); }
  for (const id of current) if (!memberSet.has(id)) { await registry.deactivate(id); removed.push(id); }
  // After reconcile every membership is registered-active and every departed channel is inactive,
  // so the active set is exactly the (deduped) memberships — no second scan needed.
  return { added, removed, active: [...new Set(botMemberships)] };
}
