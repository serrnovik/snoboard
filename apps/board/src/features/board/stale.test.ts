import { describe, expect, it } from "vitest";
import { isStale, parseBoardQuery, serializeBoardQuery, emptyBoardQuery } from "./model";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const DONE = ["done"];

describe("isStale", () => {
  it("flags open initiatives untouched for longer than the window", () => {
    const old = { status: "planned", updated: "2026-06-01", updatedAt: "2026-06-01T10:00:00Z" };
    expect(isStale(old, DONE, 30, NOW)).toBe(true);
    expect(isStale({ ...old, status: "done" }, DONE, 30, NOW)).toBe(false);
    expect(isStale({ ...old, status: "parked" }, DONE, 30, NOW)).toBe(false);
    expect(isStale({ ...old, status: "dropped" }, DONE, 30, NOW)).toBe(false);
  });

  it("uses the newer of the frontmatter date and the last commit", () => {
    expect(isStale({ status: "planned", updated: "2026-06-01", updatedAt: "2026-09-25T10:00:00Z" }, DONE, 30, NOW)).toBe(false);
    expect(isStale({ status: "planned", updated: "2026-09-20", updatedAt: "2026-01-01T00:00:00Z" }, DONE, 30, NOW)).toBe(false);
  });

  it("round-trips the hide-stale query flag", () => {
    const query = { ...emptyBoardQuery(), hideStale: true };
    const search = serializeBoardQuery("", query);
    expect(search).toBe("?stale=hide");
    expect(parseBoardQuery(search).hideStale).toBe(true);
  });
});
