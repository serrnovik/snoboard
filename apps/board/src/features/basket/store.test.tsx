// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { basketStorageKey, describeEdit, pendingDocs, resetBasketStore, useBasket } from "@/features/basket/store";

const status = { kind: "setStatus" as const, id: "acme-001", from: "planned", to: "in-progress" };
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetBasketStore();
});

describe("basket store", () => {
  it("keeps edits across a reload and clears them", () => {
    const first = renderHook(() => useBasket());
    act(() => first.result.current.add(status));
    expect(first.result.current.list()).toEqual([status]);
    expect(localStorage.getItem(basketStorageKey("default"))).toBe(JSON.stringify([status]));
    first.unmount();
    resetBasketStore();

    const second = renderHook(() => useBasket());
    expect(second.result.current.edits).toEqual([status]);
    act(() => second.result.current.clear());
    expect(second.result.current.list()).toEqual([]);
    second.unmount();
    resetBasketStore();

    const third = renderHook(() => useBasket());
    expect(third.result.current.edits).toEqual([]);
  });

  it("merges two edits of the same field, keeping the first from and the last to", () => {
    const { result } = renderHook(() => useBasket());
    act(() => {
      result.current.add(status);
      result.current.add({ kind: "setStatus", id: "acme-001", from: "in-progress", to: "review" });
      result.current.add({ kind: "setPriority", id: "acme-001", from: "p2", to: "p0" });
      result.current.add({
        kind: "setPhaseStatus",
        id: "acme-001",
        phase: 1,
        from: "planned",
        to: "in-progress",
      });
      result.current.add({
        kind: "setPhaseStatus",
        id: "acme-001",
        phase: 2,
        from: "planned",
        to: "done",
      });
      result.current.add({ kind: "setBody", id: "acme-001", fromHash: hashA, to: "first" });
      result.current.add({ kind: "setBody", id: "acme-001", fromHash: hashB, to: "second" });
    });
    expect(result.current.list()).toEqual([
      { kind: "setStatus", id: "acme-001", from: "planned", to: "review" },
      { kind: "setPriority", id: "acme-001", from: "p2", to: "p0" },
      { kind: "setPhaseStatus", id: "acme-001", phase: 1, from: "planned", to: "in-progress" },
      { kind: "setPhaseStatus", id: "acme-001", phase: 2, from: "planned", to: "done" },
      { kind: "setBody", id: "acme-001", fromHash: hashA, to: "second" },
    ]);
  });

  it("drops a status edit when the card returns to its snapshot column", () => {
    const { result } = renderHook(() => useBasket());
    act(() => {
      result.current.moveStatuses({ review: [{ id: "acme-001" }] }, () => "planned");
    });
    expect(result.current.list()).toEqual([
      { kind: "setStatus", id: "acme-001", from: "planned", to: "review" },
    ]);
    act(() => {
      result.current.moveStatuses({ planned: [{ id: "acme-001" }] }, () => "planned");
    });
    expect(result.current.list()).toEqual([]);
  });

  it("drops invalid entries and corrupted storage", () => {
    localStorage.setItem(
      basketStorageKey("default"),
      JSON.stringify([status, { kind: "setStatus", id: "nope", from: "a", to: "b" }]),
    );
    const { result, unmount } = renderHook(() => useBasket());
    expect(result.current.edits).toEqual([status]);
    expect(JSON.parse(localStorage.getItem(basketStorageKey("default")) ?? "[]")).toEqual([status]);
    unmount();
    resetBasketStore();

    localStorage.setItem(basketStorageKey("default"), "{not json");
    const broken = renderHook(() => useBasket());
    expect(broken.result.current.edits).toEqual([]);
    expect(localStorage.getItem(basketStorageKey("default"))).toBe("[]");
  });

  it("syncs a basket written in another tab", () => {
    const { result } = renderHook(() => useBasket());
    act(() => {
      localStorage.setItem(basketStorageKey("default"), JSON.stringify([status]));
      window.dispatchEvent(new StorageEvent("storage", { key: basketStorageKey("default") }));
    });
    expect(result.current.edits).toEqual([status]);
  });

  it("removes one edit by index", () => {
    const { result } = renderHook(() => useBasket());
    act(() => {
      result.current.add(status);
      result.current.add({ kind: "setPriority", id: "acme-001", from: "p1", to: "p0" });
      result.current.remove(0);
    });
    expect(result.current.list()).toEqual([{ kind: "setPriority", id: "acme-001", from: "p1", to: "p0" }]);
  });

  it("keeps a separate basket for each repository", () => {
    const acme = renderHook(() => useBasket("acme"));
    const widgets = renderHook(() => useBasket("widgets"));
    act(() => acme.result.current.add(status));
    expect(acme.result.current.list()).toEqual([status]);
    expect(widgets.result.current.list()).toEqual([]);
    expect(localStorage.getItem(basketStorageKey("acme"))).toBe(JSON.stringify([status]));
    expect(localStorage.getItem(basketStorageKey("widgets"))).toBeNull();
  });
});

describe("document edits in the basket", () => {
  it("merges edits of the same document, keeps the first hash, and keeps a created document a createDoc", () => {
    const basket = renderHook(() => useBasket());
    act(() => {
      basket.result.current.add({ kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: hashA, to: "one" });
      basket.result.current.add({ kind: "setDoc", id: "acme-001", path: "phases/phase-1.packet.md", fromHash: hashB, to: "p" });
      basket.result.current.add({ kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: hashB, to: "two" });
      basket.result.current.add({ kind: "createDoc", id: "acme-001", path: "NOTES.md", to: "draft" });
      basket.result.current.add({ kind: "setDoc", id: "acme-001", path: "NOTES.md", fromHash: hashA, to: "final" });
    });
    expect(basket.result.current.list()).toEqual([
      { kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: hashA, to: "two" },
      { kind: "setDoc", id: "acme-001", path: "phases/phase-1.packet.md", fromHash: hashB, to: "p" },
      { kind: "createDoc", id: "acme-001", path: "NOTES.md", to: "final" },
    ]);
    expect(pendingDocs(basket.result.current.list(), "acme-001").get("NOTES.md")).toEqual({ text: "final", created: true });
    expect(describeEdit(basket.result.current.list()[1]!)).toBe("acme-001 · phases/phase-1.packet.md — edited");
  });

  it("drops edits whose path is not an editable document", () => {
    localStorage.setItem(
      basketStorageKey("default"),
      JSON.stringify([
        { kind: "setDoc", id: "acme-001", path: "../x.md", fromHash: hashA, to: "x" },
        { kind: "setDoc", id: "acme-001", path: "initiative.md", fromHash: hashA, to: "x" },
        { kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: hashA, to: "ok" },
      ]),
    );
    const basket = renderHook(() => useBasket());
    expect(basket.result.current.list()).toEqual([{ kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: hashA, to: "ok" }]);
  });
});
