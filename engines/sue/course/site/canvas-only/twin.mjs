// Deterministic twin for canvas-only: clicks the painted shapes at their canvas coordinates,
// mapped through the canvas element's on-screen box.

const CANVAS = { width: 480, height: 360 };
const ORDER = [
  { x: 90, y: 210 }, // square
  { x: 240, y: 210 }, // circle
  { x: 390, y: 210 }, // diamond
];

export async function solve(page, url) {
  await page.goto(url);
  const canvas = page.locator("canvas");
  await canvas.waitFor({ state: "visible" });
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  for (const point of ORDER) {
    await page.mouse.click(box.x + (point.x * box.width) / CANVAS.width, box.y + (point.y * box.height) / CANVAS.height);
  }
  await page.getByText("Sequence complete", { exact: true }).waitFor({ state: "visible" });
}
