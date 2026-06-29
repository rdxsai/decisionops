import type { ContextRef, Visibility } from "../types.js";

export type Audience = Visibility;

// Higher = more open. A ref is inline-able iff its source is at least as open as the audience.
const OPENNESS: Record<Visibility, number> = { dm: 0, private: 1, public: 2 };

export function scopeRefs(refs: ContextRef[], audience: Audience) {
  const inline: ContextRef[] = [];
  const linkOnly: ContextRef[] = [];
  for (const r of refs) {
    if (OPENNESS[r.visibility] >= OPENNESS[audience]) inline.push(r);
    else linkOnly.push(r);
  }
  return { inline, linkOnly };
}

export function renderRef(ref: ContextRef, inline: boolean): string {
  return inline
    ? `> ${ref.snippet} — ${ref.permalink}`
    : `🔒 <${ref.permalink}|source> (open to check — your access applies)`;
}
