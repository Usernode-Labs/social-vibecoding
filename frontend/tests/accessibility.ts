import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

const shellStructureRules = new Set([
  "empty-heading",
  "heading-order",
  "landmark-main-is-top-level",
  "landmark-no-duplicate-main",
  "landmark-one-main",
  "landmark-unique",
  "page-has-heading-one",
  "region",
]);

export async function expectAccessibleShellStructure(page: Page) {
  await expect(page.getByRole("main")).toHaveCount(1);
  const navigation = page.getByRole("navigation", {
    name: "Platform navigation",
  });
  if ((await navigation.count()) === 0) {
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await expect(navigation).toHaveCount(1);
    await page.keyboard.press("Escape");
  } else {
    await expect(navigation).toHaveCount(1);
  }
  await expect(page.locator("main h1")).toHaveCount(1);

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      ({ impact }) => impact === "critical" || impact === "serious",
    ),
  ).toEqual([]);
  expect(
    results.violations.filter(
      ({ id, impact }) => impact === "moderate" && shellStructureRules.has(id),
    ),
  ).toEqual([]);
}
