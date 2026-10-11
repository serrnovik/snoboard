import { describe, expect, it } from "vitest";
import { collapseDiff, lineDiff } from "./line-diff";

function render(before: string, after: string): string {
  return lineDiff(before, after)
    .map((line) => `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.text}`)
    .join("\n");
}

describe("line diff", () => {
  it("finds the smallest change", () => {
    expect(render("a\nb\nc\n", "a\nB\nc\nd\n")).toBe(" a\n-b\n+B\n c\n+d");
    expect(render("", "x\n")).toBe("+x");
    expect(render("x\n", "")).toBe("-x");
    expect(render("same\r\nlines\r\n", "same\nlines\n")).toBe(" same\n lines");
  });

  it("rebuilds both sides on random input", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 50; round += 1) {
      const a = Array.from({ length: Math.floor(random() * 30) }, () => String.fromCharCode(97 + Math.floor(random() * 4)));
      const b = Array.from({ length: Math.floor(random() * 30) }, () => String.fromCharCode(97 + Math.floor(random() * 4)));
      const diff = lineDiff(a.join("\n"), b.join("\n"));
      expect(diff.filter((line) => line.type !== "add").map((line) => line.text)).toEqual(a);
      expect(diff.filter((line) => line.type !== "del").map((line) => line.text)).toEqual(b);
    }
  });

  it("collapses long unchanged runs", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 10", "changed");
    const collapsed = collapseDiff(lineDiff(before, after), 1);
    expect(collapsed).toEqual([
      { type: "skip", count: 9 },
      { type: "same", text: "line 9" },
      { type: "del", text: "line 10" },
      { type: "add", text: "changed" },
      { type: "same", text: "line 11" },
      { type: "skip", count: 8 },
    ]);
  });
});
