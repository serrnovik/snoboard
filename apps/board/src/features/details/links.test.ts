import { describe, expect, it } from "vitest";
import { applyForgeTemplate, forgeFileUrl, forgeFolderUrl, forgePrUrl, type ForgeLinkConfig } from "./links.js";

const forge: ForgeLinkConfig = {
  type: "github",
  repo: "acme/widgets",
  fileUrl: "https://github.com/{repo}/blob/{ref}/{path}",
  prUrl: "https://github.com/{repo}/pull/{pr}",
};

describe("forge link templates", () => {
  it("substitutes repo, ref, and path while keeping slashes", () => {
    expect(
      forgeFileUrl(forge, "initiative/acme-002", "initiatives/acme/002-billing/initiative.md"),
    ).toBe(
      "https://github.com/acme/widgets/blob/initiative/acme-002/initiatives/acme/002-billing/initiative.md",
    );
  });

  it("points the folder link at the tree URL for the parent directory", () => {
    expect(forgeFolderUrl(forge, "main", "initiatives/acme/002-billing/initiative.md")).toBe(
      "https://github.com/acme/widgets/tree/main/initiatives/acme/002-billing",
    );
  });

  it("substitutes the pull request number", () => {
    expect(forgePrUrl(forge, 12)).toBe("https://github.com/acme/widgets/pull/12");
  });

  it("encodes spaces and leaves unknown tokens in place", () => {
    expect(applyForgeTemplate("https://example.test/{path}/{missing}", { path: "a b/c" })).toBe(
      "https://example.test/a%20b/c/{missing}",
    );
  });
});
