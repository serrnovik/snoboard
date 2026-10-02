// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewInitiativeDialog, suggestSlug, templateBody } from "@/features/basket/NewInitiativeDialog";
import { resetBasketStore, useBasket } from "@/features/basket/store";

// The real editor is covered in markdown-editor.test.tsx; here a textarea stands in for it.
vi.mock("@/components/markdown-editor-impl", () => ({
  default: (props: { value: string; onChange: (value: string) => void; "aria-label": string }) => (
    <textarea
      data-testid="markdown-editor"
      aria-label={props["aria-label"]}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));

const statuses = ["planned", "in-progress", "done"];
const priorities = ["p0", "p1", "p2", "p3"];

// Enough initiatives that rendering all of them would swamp the dialog.
const many = Array.from({ length: 120 }, (_, index) => ({
  id: `acme-${String(index + 1).padStart(3, "0")}`,
  title: index === 1 ? "Billing" : `Initiative ${index + 1}`,
  done: index === 4,
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetBasketStore();
});

function renderDialog(props: Partial<Parameters<typeof NewInitiativeDialog>[0]> = {}) {
  return render(
    <NewInitiativeDialog
      projects={["acme", "widgets"]}
      initiatives={many}
      statuses={statuses}
      priorities={priorities}
      {...props}
    />,
  );
}

describe("new initiative dialog", () => {
  it("fits: fields in order, no dependency list by default, footer actions present", async () => {
    const user = userEvent.setup();
    renderDialog({ defaultProject: "widgets" });
    await user.click(screen.getByRole("button", { name: "New initiative" }));
    const dialog = screen.getByRole("dialog");

    const project = within(dialog).getByLabelText("Project") as HTMLSelectElement;
    expect(project.value).toBe("widgets");
    expect([...project.options].map((option) => option.textContent)).toEqual(["acme", "widgets", "+ New project…"]);
    const order = ["Project", "Title", "Slug", "Initiative text"].map((label) => within(dialog).getByLabelText(label));
    for (let index = 1; index < order.length; index += 1) {
      const previous = order[index - 1] as HTMLElement;
      expect(previous.compareDocumentPosition(order[index] as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(within(dialog).getByTestId("new-initiative-number").textContent).toBe("Number is assigned when you submit.");
    expect(within(dialog).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(dialog).queryAllByTestId("dependency-suggestion")).toHaveLength(0);
    expect(dialog.className).toContain("max-h-");
    expect(within(dialog).getByTestId("new-initiative-body").className).toContain("overflow-y-auto");
    expect(within(dialog).getByRole("button", { name: "Add to basket" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("queues a createInitiative with an auto slug, searched dependencies, and chip removal", async () => {
    const user = userEvent.setup();
    const basket = renderHook(() => useBasket());
    renderDialog();
    await user.click(screen.getByRole("button", { name: "New initiative" }));

    await user.type(screen.getByLabelText("Title"), "First Export!");
    expect((screen.getByLabelText("Slug") as HTMLInputElement).value).toBe("first-export");

    const search = screen.getByLabelText("Search dependencies");
    await user.type(search, "acme-0");
    expect(screen.getAllByTestId("dependency-suggestion").length).toBeLessThanOrEqual(8);
    await user.clear(search);
    await user.type(search, "billing");
    await user.click(screen.getByRole("button", { name: /acme-002/ }));
    await user.type(search, "acme-005");
    await user.click(screen.getByRole("button", { name: /acme-005/ }));
    await user.type(search, "acme-010");
    await user.click(screen.getByRole("button", { name: /acme-010/ }));
    expect(screen.getAllByTestId("dependency-chip").map((chip) => chip.textContent)).toEqual([
      "acme-002",
      "acme-005",
      "acme-010",
    ]);
    await user.click(screen.getByRole("button", { name: "Remove acme-005" }));
    expect(screen.getAllByTestId("dependency-chip")).toHaveLength(2);

    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "in-progress" }));
    await user.click(screen.getByRole("combobox", { name: "Priority" }));
    await user.click(await screen.findByRole("option", { name: "p0" }));
    await user.click(screen.getByRole("button", { name: "Add to basket" }));

    expect(basket.result.current.list()).toEqual([
      {
        kind: "createInitiative",
        project: "acme",
        slug: "first-export",
        title: "First Export!",
        status: "in-progress",
        priority: "p0",
        body: templateBody("First Export!"),
        depends_on: ["acme-002", "acme-010"],
      },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists non-done initiatives first in suggestions", async () => {
    const user = userEvent.setup();
    renderDialog({ initiatives: [{ id: "acme-001", title: "Old export", done: true }, { id: "acme-002", title: "New export" }] });
    await user.click(screen.getByRole("button", { name: "New initiative" }));
    await user.type(screen.getByLabelText("Search dependencies"), "export");
    expect(screen.getAllByTestId("dependency-suggestion").map((node) => node.textContent)).toEqual([
      "acme-002New export",
      "acme-001Old export",
    ]);
  });

  it("creates in a new project and keeps an edited slug", async () => {
    const user = userEvent.setup();
    const basket = renderHook(() => useBasket());
    renderDialog();
    await user.click(screen.getByRole("button", { name: "New initiative" }));
    await user.selectOptions(screen.getByLabelText("Project"), "+ New project…");
    await user.type(screen.getByLabelText("New project name"), "gizmo");
    await user.type(screen.getByLabelText("Title"), "Launch plan");
    const slug = screen.getByLabelText("Slug");
    await user.clear(slug);
    await user.type(slug, "launch");
    const text = await screen.findByTestId("markdown-editor");
    expect((text as HTMLTextAreaElement).value).toBe(templateBody("Launch plan"));
    await user.clear(text);
    await user.type(text, "Hello  *world*{Enter}{Enter}- [[ ] one");
    // Edited text is kept as typed; the title no longer rewrites it.
    await user.type(screen.getByLabelText("Title"), "!");
    await user.click(screen.getByRole("button", { name: "Add to basket" }));
    expect(basket.result.current.list()).toEqual([
      {
        kind: "createInitiative",
        project: "gizmo",
        slug: "launch",
        title: "Launch plan!",
        status: "planned",
        priority: "p0",
        body: ["Hello  *world*", "", "- [ ] one"].join(String.fromCharCode(10)),
      },
    ]);
  });

  it("explains an invalid new project and does not queue it", async () => {
    const user = userEvent.setup();
    const basket = renderHook(() => useBasket());
    renderDialog({ projects: [] });
    await user.click(screen.getByRole("button", { name: "New initiative" }));
    await user.type(screen.getByLabelText("New project name"), "Bad Project");
    await user.type(screen.getByLabelText("Title"), "Nope");
    await user.click(screen.getByRole("button", { name: "Add to basket" }));
    expect(screen.getByRole("alert").textContent).toContain("lowercase");
    expect(basket.result.current.list()).toEqual([]);
  });

  it("suggests slugs", () => {
    expect(suggestSlug("  Café   Déjà vu: 2.0 ")).toBe("cafe-deja-vu-2-0");
  });
});
