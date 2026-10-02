import { describe, expect, it } from "vitest";
import { formatQualifiedId, initiativeDetailsPath, parseQualifiedId, shareUrl } from "./ids.js";

describe("qualified ids", () => {
  it("formats and parses repo:project-NNN", () => {
    expect(formatQualifiedId("acme", "billing-004")).toBe("acme:billing-004");
    expect(parseQualifiedId("acme:billing-004")).toEqual({ repo: "acme", id: "billing-004" });
    expect(parseQualifiedId("default:acme-001")).toEqual({ repo: "default", id: "acme-001" });
    // Same grammar as the core schema, which allows a leading `_` or `-`.
    expect(parseQualifiedId("acme:_ops-002")).toEqual({ repo: "acme", id: "_ops-002" });
    expect(parseQualifiedId("acme:-ops-002")).toEqual({ repo: "acme", id: "-ops-002" });
  });

  it("rejects unqualified text, a bad repo id, and a bad initiative id", () => {
    expect(parseQualifiedId("billing-004")).toBeNull();
    expect(parseQualifiedId(":billing-004")).toBeNull();
    expect(parseQualifiedId("Acme:billing-004")).toBeNull();
    expect(parseQualifiedId("acme:Billing-004")).toBeNull();
    expect(parseQualifiedId("acme:billing-4")).toBeNull();
    expect(parseQualifiedId("acme:billing-004:extra")).toBeNull();
  });

  it("builds details URLs and share links from a qualified id", () => {
    expect(initiativeDetailsPath("acme", "billing-004")).toBe("/r/acme/initiatives/billing-004");
    expect(shareUrl("https://board.example", "acme", "billing-004")).toBe(
      "https://board.example/r/acme/initiatives/billing-004",
    );
    expect(initiativeDetailsPath("not a repo", "billing-004")).toBe(
      "/r/not%20a%20repo/initiatives/billing-004",
    );
  });
});
