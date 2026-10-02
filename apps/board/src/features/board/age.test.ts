import { describe, expect, it } from "vitest";
import { formatAge } from "./age";

const NOW = Date.parse("2026-09-30T12:00:00Z");

describe("formatAge", () => {
  it("formats elapsed time in the largest whole unit", () => {
    expect(formatAge("2026-09-30T11:59:30Z", NOW)).toBe("now");
    expect(formatAge("2026-09-30T11:15:00Z", NOW)).toBe("45m");
    expect(formatAge("2026-09-30T09:00:00Z", NOW)).toBe("3h");
    expect(formatAge("2026-09-27T12:00:00Z", NOW)).toBe("3d");
    expect(formatAge("2026-07-30T12:00:00Z", NOW)).toBe("2mo");
    expect(formatAge("2025-03-01T12:00:00Z", NOW)).toBe("1y");
  });

  it("clamps future times and rejects garbage", () => {
    expect(formatAge("2026-10-01T00:00:00Z", NOW)).toBe("now");
    expect(formatAge("not a date", NOW)).toBeNull();
  });
});
