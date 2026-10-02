import { describe, expect, it } from "vitest";
import { issueLinkFor, issueRefFromUrl, normalizeIssueRef, parseIssueRef } from "./issues.js";

describe("parseIssueRef", () => {
  it("parses a GitHub issue number", () => {
    expect(parseIssueRef("gh#123")).toEqual({
      provider: "gh",
      key: "123",
      raw: "gh#123",
      known: true,
    });
  });

  it("parses a GitHub issue qualified with owner and name", () => {
    expect(parseIssueRef("gh:acme/widgets#45")).toEqual({
      provider: "gh",
      key: "acme/widgets#45",
      raw: "gh:acme/widgets#45",
      known: true,
    });
  });

  it("parses a Vikunja task id", () => {
    expect(parseIssueRef("vikunja:456")).toEqual({
      provider: "vikunja",
      key: "456",
      raw: "vikunja:456",
      known: true,
    });
  });

  it("accepts a generic provider prefix as unknown", () => {
    expect(parseIssueRef("linear:ABC-1")).toEqual({
      provider: "linear",
      key: "ABC-1",
      raw: "linear:ABC-1",
      known: false,
    });
  });

  it("rejects malformed known-provider refs", () => {
    for (const text of ["gh#", "gh#0", "gh#012", "gh:acme#1", "gh:acme/widgets#", "vikunja:", "vikunja:0", "vikunja:abc"]) {
      expect(parseIssueRef(text)).toBeUndefined();
    }
  });

  it("rejects text that is not a ref", () => {
    for (const text of ["", "123", "GH#123", "gh#123 ", "no-colon", ":key", "Linear:ABC-1"]) {
      expect(parseIssueRef(text)).toBeUndefined();
    }
  });
});

describe("vj alias", () => {
  it("parses vj:<n> as a Vikunja task", () => {
    expect(parseIssueRef("vj:45")).toEqual({ provider: "vikunja", key: "45", raw: "vj:45", known: true });
  });

  it("rejects a malformed vj ref instead of treating it as generic", () => {
    expect(parseIssueRef("vj:abc")).toBeUndefined();
    expect(parseIssueRef("vj:0")).toBeUndefined();
  });

  it("normalizes vikunja:<n> to vj:<n> and leaves other refs alone", () => {
    expect(normalizeIssueRef(" vikunja:45 ")).toBe("vj:45");
    expect(normalizeIssueRef("vj:45")).toBe("vj:45");
    expect(normalizeIssueRef("gh#3")).toBe("gh#3");
  });
});

describe("issueRefFromUrl", () => {
  const config = { vikunjaBaseUrl: "https://tasks.example.com/", githubRepo: "acme/widgets" };

  it("returns undefined for text that is not a URL", () => {
    expect(issueRefFromUrl("gh#12", config)).toBeUndefined();
  });

  it("maps the repo's own GitHub issues and pulls to gh#<n>", () => {
    expect(issueRefFromUrl("https://github.com/acme/widgets/issues/12", config)).toEqual({ ref: "gh#12" });
    expect(issueRefFromUrl("https://github.com/Acme/Widgets/pull/7/", config)).toEqual({ ref: "gh#7" });
  });

  it("qualifies other GitHub repos", () => {
    expect(issueRefFromUrl("https://github.com/other/thing/issues/3", config)).toEqual({ ref: "gh:other/thing#3" });
    expect(issueRefFromUrl("https://github.com/acme/widgets/issues/3", {})).toEqual({ ref: "gh:acme/widgets#3" });
  });

  it("rejects GitHub URLs that are not issues", () => {
    expect(issueRefFromUrl("https://github.com/acme/widgets/tree/main", config)).toHaveProperty("error");
  });

  it("maps a Vikunja task on the configured host to vj:<n>", () => {
    expect(issueRefFromUrl("https://tasks.example.com/tasks/45", config)).toEqual({ ref: "vj:45" });
  });

  it("honours a Vikunja base path", () => {
    const sub = { vikunjaBaseUrl: "https://example.com/vikunja" };
    expect(issueRefFromUrl("https://example.com/vikunja/tasks/9", sub)).toEqual({ ref: "vj:9" });
    expect(issueRefFromUrl("https://example.com/tasks/9", sub)).toHaveProperty("error");
  });

  it("rejects a Vikunja-looking URL on another host", () => {
    const result = issueRefFromUrl("https://other.example.org/tasks/45", config);
    expect(result).toEqual({ error: "other.example.org is not this repository's GitHub or Vikunja site." });
  });

  it("rejects any task URL when no Vikunja site is configured", () => {
    expect(issueRefFromUrl("https://tasks.example.com/tasks/45", {})).toHaveProperty("error");
  });
});

describe("issueLinkFor", () => {
  const config = { vikunjaBaseUrl: "https://tasks.example.com", githubRepo: "acme/widgets" };

  it("builds links from config only", () => {
    expect(issueLinkFor("gh#12", config)).toBe("https://github.com/acme/widgets/issues/12");
    expect(issueLinkFor("gh:other/thing#3", {})).toBe("https://github.com/other/thing/issues/3");
    expect(issueLinkFor("vj:45", config)).toBe("https://tasks.example.com/tasks/45");
    expect(issueLinkFor("vikunja:45", config)).toBe("https://tasks.example.com/tasks/45");
  });

  it("returns empty when config is missing or the provider is unknown", () => {
    expect(issueLinkFor("gh#12", {})).toBe("");
    expect(issueLinkFor("vj:45", {})).toBe("");
    expect(issueLinkFor("linear:ABC-1", config)).toBe("");
  });
});
