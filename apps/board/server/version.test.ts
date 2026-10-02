import { VERSION } from "snoboard";
import { describe, expect, it } from "vitest";
import { boardVersion } from "./version.js";

describe("boardVersion", () => {
  it("uses SNOBOARD_VERSION when set", () => {
    expect(boardVersion({ SNOBOARD_VERSION: " 0.1.16.1 " })).toBe("0.1.16.1");
  });

  it("falls back to the package version when unset, blank or unsafe", () => {
    expect(boardVersion({})).toBe(VERSION);
    expect(boardVersion({ SNOBOARD_VERSION: "  " })).toBe(VERSION);
    expect(boardVersion({ SNOBOARD_VERSION: "<script>" })).toBe(VERSION);
  });
});
