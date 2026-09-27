// Sugeneruoja PNG failus iš reklamos.html: `node reklamos/render.js`
// Reikia Playwright (npm i -g playwright arba npx playwright).
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto('file://' + path.join(__dirname, 'reklamos.html'));
  await page.evaluate(() => document.fonts.ready);
  const ids = await page.$$eval('.ad', els => els.map(e => e.id));
  for (const id of ids) {
    await page.locator(`[id="${id}"]`).screenshot({ path: path.join(__dirname, 'png', id + '.png') });
    console.log('✓', id);
  }
  await browser.close();
})();
