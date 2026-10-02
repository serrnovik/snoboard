import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PASSWORD } from "./constants.ts";

// Regenerates the README screenshots in docs/img from the demo repository
// (examples/make-demo-remote.mjs). Runs after edits.spec.ts, so acme-004
// already shows a proposed change from an open pull request.
const imgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/img");

async function shot(page: Page, name: string): Promise<void> {
  // Let fonts, layout and the graph settle before capturing.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(imgDir, name), animations: "disabled" });
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("card-acme-002")).toBeVisible({ timeout: 30_000 });
}

async function setTheme(page: Page, theme: "Light" | "Dark"): Promise<void> {
  await page.getByRole("radio", { name: theme }).click();
  if (theme === "Dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

test("README screenshots", async ({ page }) => {
  await mkdir(imgDir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await setTheme(page, "Light");

  // Details panel with edit controls, issues and links; queue "done" on a
  // billing initiative that still has open phases.
  await page.goto("/?open=acme-002");
  const details = page.getByRole("dialog");
  await expect(details.getByTestId("edit-controls")).toBeVisible();
  await expect(details.getByText("Pricing design doc")).toBeVisible();
  const edit = details.getByTestId("edit-controls");
  await edit.getByRole("combobox", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: "done", exact: true }).click();
  await expect(page.getByTestId("basket-count")).toHaveText("1");
  await shot(page, "details.png");
  await page.keyboard.press("Escape");

  await page.goto("/?open=platform-002");
  const second = page.getByRole("dialog").getByTestId("edit-controls");
  await second.getByRole("combobox", { name: "Priority", exact: true }).click();
  await page.getByRole("option", { name: "p0", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.goto("/");
  await expect(page.getByTestId("basket-count")).toHaveText("2");
  await expect(page.getByTestId("card-acme-004").getByTestId("proposed-badge")).toBeVisible();
  await shot(page, "board.png");

  // Submit dialog: one edit fails validation and offers a one-click fix.
  await page.getByTestId("basket-panel").getByRole("button", { name: "Submit" }).click();
  const submit = page.getByRole("dialog", { name: "Submit basket" });
  await expect(submit.getByTestId("validate-summary")).toHaveText("1 of 2 edits needs attention");
  await expect(submit.getByRole("button", { name: "Also mark the open phase done" })).toBeVisible();
  await expect(submit.getByRole("button", { name: "Submit the 1 valid edit" })).toBeVisible();
  await shot(page, "submit-invalid.png");
  await submit.getByRole("button", { name: "Also mark the open phase done" }).click();
  await expect(submit.getByTestId("validate-summary")).toHaveText("All 3 edits are valid");
  await submit.getByRole("radio", { name: "Open a pull request" }).check();
  await shot(page, "submit.png");
  await page.keyboard.press("Escape");
  await expect(submit).toBeHidden();

  // New initiative with the markdown editor.
  await page.getByRole("button", { name: "New initiative" }).click();
  const create = page.getByRole("dialog", { name: "New initiative" });
  await create.getByLabel("Title", { exact: true }).fill("Self-serve data export");
  const text = create.getByLabel("Initiative text");
  await text.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(
    "## Summary\n\nAccount owners export their data as CSV or JSON without a support ticket.\n\n## Goals\n\n- Export from the account area\nEmail a link when the export is ready",
  );
  await shot(page, "new-initiative.png");
  await page.keyboard.press("Escape");

  await page.getByRole("link", { name: "Dependencies" }).click();
  await expect(page.getByLabel("Dependency graph")).toBeVisible();
  await expect(page.getByText("acme-002").first()).toBeVisible();
  // Phase nodes on top of the default view (done and unlinked initiatives hidden).
  await page.getByRole("switch", { name: "Show phase nodes" }).click();
  await expect(page.getByText("Invoices").first()).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, "graph.png");

  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page.getByTestId("card-acme-002")).toBeVisible();
  await setTheme(page, "Dark");
  await shot(page, "board-dark.png");
  await setTheme(page, "Light");
});
