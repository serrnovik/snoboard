import { describe, expect, it } from "vitest";
import { diffBaskets, editKey, mergeBaskets, mergeIntoBasket } from "./basket.js";
import type { Edit } from "./edit-schema.js";

const status = (id: string, from: string, to: string): Edit => ({ kind: "setStatus", id, from, to });
const doc = (to: string): Edit => ({ kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: "a".repeat(64), to });

describe("basket keys and merges", () => {
  it("keys edits by what they change", () => {
    expect(editKey(status("acme-001", "idea", "done"))).toBe("setStatus:acme-001");
    expect(editKey({ kind: "setPhaseStatus", id: "acme-001", phase: 2, from: "idea", to: "done" })).toBe("setPhaseStatus:acme-001:2");
    expect(editKey(doc("x"))).toBe(editKey({ kind: "createDoc", id: "acme-001", path: "ROADMAP.md", to: "y" }));
    expect(editKey({ kind: "createInitiative", project: "acme", slug: "new", title: "New", status: "idea", priority: "p2" })).toBe(
      "create:acme/new",
    );
  });

  it("queues like the board basket: same target replaced, first `from` kept, no-ops dropped", () => {
    let basket = mergeIntoBasket([], status("acme-001", "idea", "planned"));
    basket = mergeIntoBasket(basket, status("acme-001", "planned", "done"));
    expect(basket).toEqual([status("acme-001", "idea", "done")]);
    basket = mergeIntoBasket(basket, status("acme-001", "done", "idea"));
    expect(basket).toEqual([]);
  });

  it("diffs and three-way merges by key", () => {
    const base = [status("acme-001", "idea", "planned"), doc("one")];
    const local = [doc("two"), status("acme-003", "idea", "done")];
    const change = diffBaskets(base, local);
    expect(change.removedKeys).toEqual(["setStatus:acme-001"]);
    expect(change.changedKeys.sort()).toEqual(["doc:acme-001:ROADMAP.md", "setStatus:acme-003"]);
    // Meanwhile another device added a priority edit and changed the same document.
    const stored = [status("acme-001", "idea", "planned"), doc("other device"), { kind: "setPriority", id: "acme-002", from: "p1", to: "p0" } as Edit];
    expect(mergeBaskets(stored, local, change)).toEqual([doc("two"), stored[2], status("acme-003", "idea", "done")]);
  });
});
