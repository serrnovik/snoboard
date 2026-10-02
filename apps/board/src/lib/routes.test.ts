import { describe, expect, it } from "vitest";
import { chooseRepoId, legacyRedirectPath, pathForRepoSwitch } from "./routes.js";

const repos = [{ id: "acme" }, { id: "widgets" }];

describe("old URLs redirect", () => {
  it("sends /, /graph, and /initiatives/<id> to the last used repo when it is still listed", () => {
    expect(chooseRepoId(repos, "widgets")).toBe("widgets");
    expect(legacyRedirectPath("/", "?legacy=1", "widgets")).toBe("/r/widgets/?legacy=1");
    expect(legacyRedirectPath("/graph", "", "widgets")).toBe("/r/widgets/graph");
    expect(legacyRedirectPath("/initiatives/acme-002", "?open=1", "widgets")).toBe(
      "/r/widgets/initiatives/acme-002?open=1",
    );
  });

  it("sends an unqualified initiative bookmark to the repo the legacy API serves", () => {
    expect(legacyRedirectPath("/initiatives/acme-002", "", "widgets", "acme")).toBe("/r/acme/initiatives/acme-002");
    expect(legacyRedirectPath("/", "", "widgets", "acme")).toBe("/r/widgets/");
    expect(legacyRedirectPath("/graph", "", "widgets", "acme")).toBe("/r/widgets/graph");
  });

  it("falls back to the first repo when nothing was remembered", () => {
    expect(chooseRepoId(repos, null)).toBe("acme");
    expect(chooseRepoId(repos, "missing")).toBe("acme");
    expect(legacyRedirectPath("/", "", "acme")).toBe("/r/acme/");
    expect(legacyRedirectPath("/graph/", "", "acme")).toBe("/r/acme/graph");
  });

  it("honors a qualified id in an old initiative bookmark", () => {
    expect(legacyRedirectPath("/initiatives/widgets%3Abilling-004", "", "acme")).toBe(
      "/r/widgets/initiatives/billing-004",
    );
  });

  it("keeps the board or graph when the repository changes and leaves an initiative", () => {
    expect(pathForRepoSwitch("/r/acme/", "?project=billing", "widgets")).toBe("/r/widgets/?project=billing");
    expect(pathForRepoSwitch("/r/acme/graph", "", "widgets")).toBe("/r/widgets/graph");
    expect(pathForRepoSwitch("/r/acme/initiatives/billing-004", "?open=1", "widgets")).toBe("/r/widgets/");
  });

  it("drops ?open= on a repo switch and keeps the other query parameters", () => {
    expect(pathForRepoSwitch("/r/acme/", "?project=billing&open=acme-001&q=x", "widgets")).toBe(
      "/r/widgets/?project=billing&q=x",
    );
    expect(pathForRepoSwitch("/r/acme/graph", "?open=acme-001", "widgets")).toBe("/r/widgets/graph");
    expect(pathForRepoSwitch("/", "?open=acme-001", "widgets")).toBe("/r/widgets/");
  });
});
