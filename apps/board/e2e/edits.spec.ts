import { expect, test } from "@playwright/test";
import { E2E_PASSWORD } from "./constants.ts";

// GitHub is the in-process fake from fake-github.mjs, backed by the demo bare
// remote: the submit writes a real edit branch that the board then fetches.
const BOT_TOKEN = "e2e-synthetic-bot-token";

test("queue two edits, validate, submit a PR, and see the card as proposed", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("card-acme-004")).toBeVisible({ timeout: 30_000 });

  await page.goto("/?open=acme-004");
  const details = page.getByRole("dialog");
  const edit = details.getByTestId("edit-controls");
  await expect(edit).toBeVisible();
  await edit.getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name: "planned", exact: true }).click();
  await edit.getByRole("combobox", { name: "Priority" }).click();
  await page.getByRole("option", { name: "p2", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("basket-count")).toHaveText("2");

  await page.getByTestId("basket-panel").getByRole("button", { name: "Submit" }).click();
  const submit = page.getByRole("dialog", { name: "Submit basket" });
  await expect(submit.getByTestId("validate-result")).toHaveCount(2);
  await submit.getByRole("radio", { name: "Open a pull request" }).check();
  await submit.getByRole("button", { name: "Submit edits" }).click();
  await expect(submit.getByTestId("submit-pr")).toHaveText(/^Opened PR #\d+$/);
  await expect(submit.getByTestId("submit-pr")).toHaveAttribute("href", /^https:\/\/github\.com\/owner\/name\/pull\/\d+$/);
  await expect(submit.getByTestId("submitted-edit")).toHaveCount(2);
  await expect(submit.getByTestId("submitted-edit").first()).toContainText("acme-004 · ");
  await submit.getByRole("button", { name: "Done" }).click();
  await expect(submit).toBeHidden();

  // The submit asks for a refresh; the edit branch shows up as a proposal.
  await expect(async () => {
    await page.goto("/");
    await expect(page.getByTestId("card-acme-004").getByTestId("proposed-badge")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const card = page.getByTestId("card-acme-004");
  await expect(card.getByTestId("proposed-value").filter({ hasText: "planned" })).toBeVisible();
  await expect(card.getByTestId("proposed-value").filter({ hasText: "p2" })).toBeVisible();

  // The bot token is never handed to the browser.
  const board = await page.request.get("/api/board");
  const config = await page.request.get("/api/edit-config");
  expect(await board.text()).not.toContain(BOT_TOKEN);
  expect(await config.text()).not.toContain(BOT_TOKEN);
  expect(await page.content()).not.toContain(BOT_TOKEN);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(stored).not.toContain(BOT_TOKEN);
});

test("submit refuses a request without the CSRF token", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("card-acme-004")).toBeVisible({ timeout: 30_000 });
  const response = await page.request.post("/api/edits/submit", {
    data: { edits: [{ kind: "setStatus", id: "acme-004", from: "idea", to: "done" }], mode: "direct" },
  });
  expect(response.status()).toBe(403);
  expect(((await response.json()) as { code: string }).code).toBe("csrf");
});
