const { chromium, devices } = require('playwright');
const URL = process.env.HUD_CHECK_URL || 'http://127.0.0.1:63179/';

(async () => {
  const browser = await chromium.launch({ headless: true });
  for (const name of ['iPhone SE', 'Pixel 5', 'Galaxy S9+']) {
    const d = devices[name];
    const ctx = await browser.newContext({ ...d });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('squirrelStreet.controlType', 'dpad');
      localStorage.setItem('squirrelStreet.hasSelectedControls', '1');
      localStorage.setItem('squirrelStreet.lastSeenVersion', '99.99');
    });
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#continueButton', { state: 'visible', timeout: 90000 });
    await page.click('#continueButton');
    await page.waitForSelector('#playButton', { state: 'visible' });
    await page.click('#playButton');
    await page.click('#soloRunButton');
    await page.waitForSelector('#gameScreen:not(.hidden)');
    await page.waitForTimeout(700);
    await page.locator('#hudLevel').evaluate((el) => {
      el.textContent = '12';
    });
    await page.locator('#hudScore').evaluate((el) => {
      el.textContent = '1234';
    });
    await page.locator('#hudHighScore').evaluate((el) => {
      el.textContent = '9999';
    });
    await page.locator('#hudLives').evaluate((el) => {
      el.textContent = '3';
    });
    const m = await page.evaluate(() => {
      const hudEl = document.querySelector('.hud');
      const pauseEl = document.querySelector('#pauseButton');
      const hud = hudEl.getBoundingClientRect();
      const pause = pauseEl.getBoundingClientRect();
      const cs = getComputedStyle(pauseEl);
      return {
        hudTop: Math.round(hud.top * 10) / 10,
        hudH: Math.round(hud.height),
        pauseH: Math.round(pause.height),
        pauseDelta: Math.round(pause.top + pause.height / 2 - (hud.top + hud.height / 2)),
        pauseBottomPastHud: Math.round(pause.bottom - hud.bottom),
        pauseTransform: cs.transform,
        pauseMargin: cs.margin,
        ver: document.getElementById('screenVersion').textContent
      };
    });
    const file =
      'tmp-hud-shots/v215-' + name.replace(/\s+/g, '-').replace('+', '') + '.png';
    await page.screenshot({
      path: file,
      clip: {
        x: 0,
        y: 0,
        width: page.viewportSize().width,
        height: Math.min(120, page.viewportSize().height)
      }
    });
    console.log(name, JSON.stringify(m));
    await ctx.close();
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
