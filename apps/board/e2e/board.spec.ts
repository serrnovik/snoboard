import { expect, test, type Locator } from "@playwright/test";
import { E2E_PASSWORD } from "./constants.ts";

test("unauthenticated board API returns 401", async ({ request }) => {
  const response = await request.get("/api/board");
  expect(response.status()).toBe(401);
});

test("password login walks the board, details, and graph", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const login = await page.goto("/login");
  expect(await login?.text()).toContain('localStorage.getItem("snoboard-theme")');
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "In progress" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("card-acme-002")).toBeVisible();
  await expect(page.getByTestId("card-acme-003")).toBeVisible();

  await page.getByRole("combobox", { name: "Project" }).click();
  await page.getByRole("option", { name: "acme" }).click();
  await expect(page).toHaveURL(/project=acme/);
  await expect(page.getByTestId("card-acme-002")).toBeVisible();

  await page.getByRole("link", { name: "Usage-based billing" }).click();
  await expect(page).toHaveURL(/open=acme-002/);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Customers are charged per active seat, with invoices in the account area.")).toBeVisible();
  const fileLink = dialog.getByRole("link", { name: "initiative.md" });
  await expect(fileLink).toHaveAttribute("rel", "noopener noreferrer");
  await expect(fileLink).toHaveAttribute("href", /github\.com\/owner\/name\/blob\//);
  await dialog.getByRole("link", { name: "Open full page" }).click();
  await expect(page).toHaveURL(/\/initiatives\/acme-002$/);
  await expect(page.getByRole("heading", { name: "Usage-based billing" })).toBeVisible();
  await expect(page.getByText("Customers are charged per active seat, with invoices in the account area.")).toBeVisible();

  await page.getByRole("link", { name: "Dependencies" }).click();
  await expect(page.getByLabel("Dependency graph")).toBeVisible();
  await expect(page.getByText("acme-002").first()).toBeVisible();

  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  const reloaded = await page.reload();
  expect(await reloaded?.text()).toContain('localStorage.getItem("snoboard-theme")');
  await expect(page.getByLabel("Dependency graph")).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("radio", { name: "Light" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  const refresh = page.waitForResponse(
    (response) => response.url().endsWith("/refresh") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Refresh" }).click();
  expect((await refresh).status()).toBe(202);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?legacy=1");
  await expect(page).toHaveURL(/legacy=1/);
  await expect(page.getByRole("heading", { name: "In progress" })).toBeVisible();

  const boardLink = page.getByRole("link", { name: "Board", exact: true });
  const dependenciesLink = page.getByRole("link", { name: "Dependencies" });
  const logout = page.getByRole("button", { name: "Log out" });
  const theme = page.getByRole("radiogroup", { name: "Theme" });
  await expect(boardLink).toBeVisible();
  await expect(dependenciesLink).toBeVisible();
  await expect(logout).toBeVisible();
  await expect(theme).toBeVisible();
  const boardBox = await boxWithinViewport(boardLink, 390, 844);
  const dependenciesBox = await boxWithinViewport(dependenciesLink, 390, 844);
  const logoutBox = await boxWithinViewport(logout, 390, 844);
  const themeBox = await boxWithinViewport(theme, 390, 844);
  expect(overlaps(boardBox, logoutBox)).toBe(false);
  expect(overlaps(dependenciesBox, logoutBox)).toBe(false);
  expect(overlaps(dependenciesBox, themeBox)).toBe(false);
  expect(overlaps(boardBox, themeBox)).toBe(false);

  const legacySwitch = page.getByRole("switch", { name: "Show legacy" });
  await expect(legacySwitch).toBeChecked();
  const legacySection = page.locator("details").filter({ hasText: /Legacy \(\d+\)/ });
  await expect(legacySection).toBeVisible();
  await expect(legacySection).toHaveJSProperty("open", false);
  const legacyTitle = legacySection.getByText("Old migration notes");
  const legacyPath = legacySection.getByText("initiatives/platform/000-legacy-notes/initiative.md");
  await expect(legacyTitle).toBeAttached();
  await expect(legacyPath).toBeAttached();
  await expect(legacyTitle).toBeHidden();
  await expect(legacyPath).toBeHidden();
  await legacySection.locator("summary").click();
  await expect(legacySection).toHaveJSProperty("open", true);
  await expect(legacyTitle).toBeVisible();
  await expect(legacyPath).toBeVisible();

  await legacySwitch.click();
  await expect(page).not.toHaveURL(/legacy=/);
  await expect(page.locator("details").filter({ hasText: /Legacy \(/ })).toHaveCount(0);
  await legacySwitch.click();
  await expect(page).toHaveURL(/legacy=1/);
  await expect(page.locator("details").filter({ hasText: /Legacy \(\d+\)/ })).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByLabel("Password")).toBeVisible();
});

test("demo repo shows issue refs on the card and in details", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  const card = page.getByTestId("card-acme-003");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("issue-count")).toHaveAttribute("aria-label", "3 issues");
  await card.getByRole("link", { name: "Monthly usage reports" }).click();
  const list = page.getByRole("dialog").getByTestId("issue-list");
  await expect(list.getByText("gh#12")).toBeVisible();
  await expect(list.getByText("gh:acme/widgets#45")).toBeVisible();
  await expect(list.getByText("vikunja:34")).toBeVisible();
  await expect(list.locator("[role=alert]")).toHaveCount(0);
});

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function boxWithinViewport(
  locator: Locator,
  width: number,
  height: number,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) throw new Error("missing bounding box");
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
  return box;
}
