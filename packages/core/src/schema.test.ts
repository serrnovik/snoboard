import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { InitiativeFrontmatterSchema } from "./schema.js";

const config = loadConfig();
const schema = InitiativeFrontmatterSchema(config);

const example = {
  id: "acme-073",
  title: "Short human title",
  status: "planned",
  priority: "p1",
  depends_on: ["acme-070", "_shared-011", "billing-015#2"],
  branch: "initiative/acme-073-short-name",
  updated: "2026-09-28",
  labels: ["site"],
  phases: [
    {
      id: 1,
      title: "Foundations",
      status: "in-progress",
      pr: 412,
      depends_on: [1],
    },
  ],
};

describe("InitiativeFrontmatterSchema", () => {
  it("accepts the frontmatter example", () => {
    expect(schema.parse(example)).toEqual(example);
  });

  it("keeps unknown keys such as vikunja", () => {
    const parsed = schema.parse({
      ...example,
      vikunja: { board: "alpha" },
    });
    expect(parsed).toHaveProperty("vikunja", { board: "alpha" });
    expect(parsed.id).toBe("acme-073");
  });

  it("rejects a bad status", () => {
    expect(schema.safeParse({ ...example, status: "shipping" }).success).toBe(false);
  });

  it("rejects a bad priority", () => {
    expect(schema.safeParse({ ...example, priority: "p9" }).success).toBe(false);
  });

  it("rejects a malformed depends_on entry", () => {
    expect(schema.safeParse({ ...example, depends_on: ["acme-1"] }).success).toBe(false);
    expect(schema.safeParse({ ...example, depends_on: ["ACME-001"] }).success).toBe(false);
    expect(schema.safeParse({ ...example, depends_on: ["acme-001#"] }).success).toBe(false);
    expect(schema.safeParse({ ...example, depends_on: ["acme-001#001"] }).success).toBe(false);
    expect(schema.safeParse({ ...example, depends_on: ["acme-001#01"] }).success).toBe(false);
  });

  it("rejects a missing id", () => {
    const { id: _id, ...withoutId } = example;
    expect(schema.safeParse(withoutId).success).toBe(false);
  });

  it("rejects a non-date updated", () => {
    expect(schema.safeParse({ ...example, updated: "yesterday" }).success).toBe(false);
    expect(schema.safeParse({ ...example, updated: "2026-02-31" }).success).toBe(false);
  });

  it("accepts an optional issues list of strings", () => {
    expect(
      schema.parse({
        ...example,
        issues: ["gh#12", "gh:acme/widgets#3", "vikunja:9", "linear:ABC-1", "not a ref"],
      }).issues,
    ).toEqual(["gh#12", "gh:acme/widgets#3", "vikunja:9", "linear:ABC-1", "not a ref"]);
  });

  it("rejects an issues entry that is not a string", () => {
    expect(schema.safeParse({ ...example, issues: [12] }).success).toBe(false);
  });
});
