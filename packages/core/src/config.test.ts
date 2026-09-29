import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const defaults = {
  root: "initiatives",
  file: "initiative.md",
  idFormat: "{project}-{number}",
  defaultBranch: "main",
  branchPatterns: ["initiative/*"],
  statuses: ["idea", "planned", "in-progress", "review", "done", "parked", "dropped"],
  doneStatuses: ["done"],
  priorities: ["p0", "p1", "p2", "p3"],
  staleAfterDays: 30,
  reservedNumbers: [],
  forge: {
    type: "github",
    repo: "owner/name",
    fileUrl: "https://github.com/{repo}/blob/{ref}/{path}",
    prUrl: "https://github.com/{repo}/pull/{pr}",
  },
};

describe("loadConfig", () => {
  it("returns the documented defaults when no file is provided", () => {
    expect(loadConfig()).toEqual(defaults);
    expect(loadConfig(undefined)).toEqual(defaults);
    expect(loadConfig("")).toEqual(defaults);
    expect(loadConfig("# no keys\n")).toEqual(defaults);

    const first = loadConfig();
    first.statuses.push("extra");
    expect(loadConfig().statuses).toEqual(defaults.statuses);
  });

  it("merges a partial config over the defaults", () => {
    const config = loadConfig(`
staleAfterDays: 14
statuses: [todo, finished]
doneStatuses: [finished]
`);
    expect(config).toEqual({
      ...defaults,
      staleAfterDays: 14,
      statuses: ["todo", "finished"],
      doneStatuses: ["finished"],
    });
    expect(config.root).toBe("initiatives");
    expect(config.priorities).toEqual(defaults.priorities);
  });

  it("rejects a doneStatuses value that is not in statuses", () => {
    expect(() => loadConfig("doneStatuses: [archived]\n")).toThrowError(/archived/);
    expect(() => loadConfig("doneStatuses: [archived]\n")).toThrowError(/statuses/);
  });

  it("fills forge defaults and rejects a repo that is not owner/name", () => {
    expect(loadConfig("forge:\n  repo: acme/widgets\n").forge).toEqual({
      type: "github",
      repo: "acme/widgets",
      fileUrl: "https://github.com/{repo}/blob/{ref}/{path}",
      prUrl: "https://github.com/{repo}/pull/{pr}",
    });
    expect(() => loadConfig("forge:\n  repo: not-a-repo\n")).toThrowError(/owner\/name/);
    expect(() => loadConfig("forge:\n  type: gitlab\n")).toThrowError(/github/);
  });
});

