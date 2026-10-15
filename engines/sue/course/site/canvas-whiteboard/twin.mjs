// Deterministic twin for canvas-whiteboard: drags each painted shape onto its slot with real mouse
// press-move-release at canvas coordinates, clicks the painted Save, and reads success from pixels.

/** Maps a canvas-space point (640x440) to page coordinates. */
async function toPage(page, x, y) {
  const b = await page.locator("#board").boundingBox();
  return { x: b.x + (x * b.width) / 640, y: b.y + (y * b.height) / 440 };
}

/** Drags from one canvas point to another in small steps. */
async function drag(page, from, to) {
  const a = await toPage(page, from.x, from.y);
  const z = await toPage(page, to.x, to.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(z.x, z.y, { steps: 12 });
  await page.mouse.up();
}

/** Places both shapes, presses Save and waits for the painted "Design saved" banner. */
export async function solve(page, url) {
  await page.goto(url);
  await page.locator("#board").waitFor({ state: "attached" });
  await drag(page, { x: 105, y: 165 }, { x: 475, y: 165 });
  await drag(page, { x: 105, y: 320 }, { x: 475, y: 320 });
  const save = await toPage(page, 570, 28);
  await page.mouse.click(save.x, save.y);
  await page.waitForFunction(() => {
    const c = document.getElementById("board");
    const d = c.getContext("2d").getImageData(0, 400, 640, 36).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] === 0 && d[i + 1] === 170 && d[i + 2] === 0) return true;
    return false;
  });
}

/** True when the green "Design saved" banner is painted in the canvas status band. */
export async function paintedSuccess(page) {
  return page.evaluate(() => {
    const c = document.getElementById("board");
    if (!c) return false;
    const d = c.getContext("2d").getImageData(0, 400, 640, 36).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] === 0 && d[i + 1] === 170 && d[i + 2] === 0) n++;
    return n > 20;
  });
}
