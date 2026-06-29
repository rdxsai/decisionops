import { describe, it, expect } from "vitest";
import { scopeRefs, renderRef } from "../../src/permissions/scope";
import type { ContextRef } from "../../src/types";

const ref = (visibility: ContextRef["visibility"]): ContextRef =>
  ({ permalink: "p", channelId: "C", ts: "1.0", snippet: "secret detail", visibility });

describe("scopeRefs", () => {
  it("keeps public refs inline for a private-audience brief", () => {
    const { inline, linkOnly } = scopeRefs([ref("public")], "private");
    expect(inline).toHaveLength(1);
    expect(linkOnly).toHaveLength(0);
  });
  it("downgrades private refs to link-only for a public-audience brief", () => {
    const { inline, linkOnly } = scopeRefs([ref("private")], "public");
    expect(inline).toHaveLength(0);
    expect(linkOnly).toHaveLength(1);
  });
});

describe("renderRef", () => {
  it("omits the snippet for link-only refs (no laundering)", () => {
    expect(renderRef(ref("private"), false)).not.toContain("secret detail");
    expect(renderRef(ref("public"), true)).toContain("secret detail");
  });
});
