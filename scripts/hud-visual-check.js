/**
 * Capture HUD screenshots at common phone sizes for visual alignment QA.
 * Usage: node scripts/hud-visual-check.js
 */
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');

const OUT = path.join(__dirname, '..', 'tmp-hud-shots');
const URL = process.env.HUD_CHECK_URL || 'http://127.0.0.1:5173/';

const VIEWPORTS = [
  { name: 'iphone-se', ...devices['iPhone SE'] },
  { name: 'iphone-12', ...devices['iPhone 12'] },
  { name: 'iphone-14-pro-max', ...devices['iPhone 14 Pro Max'] },
  { name: 'pixel-5', ...devices['Pixel 5'] },
  { name: 'galaxy-s9', ...devices['Galaxy S9+'] },
  { name: 'narrow-320', viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true },
  { name: 'tall-390', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: 'wide-phone-430', viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true },
];

async function startSolo(page) {
  await page.addInitScript(() => {
    localStorage.setItem('squirrelStreet.controlType', 'dpad');
    localStorage.setItem('squirrelStreet.hasSelectedControls', '1');
    localStorage.setItem('squirrelStreet.lastSeenVersion', '99.99');
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#continueButton', { state: 'visible', timeout: 90000 });
  await page.click('#continueButton');
  await page.waitForSelector('#menuScreen:not(.hidden)', { timeout: 30000 });
  await page.waitForSelector('#playButton', { state: 'visible', timeout: 30000 });
  // Dismiss changelog if shown
  const closeChangelog = page.locator('#closeChangelogButton, .changelog-close, #changelogOverlay .pill-button').first();
  if (await closeChangelog.isVisible().catch(() => false)) {
    await closeChangelog.click().catch(() => {});
  }
  await page.click('#playButton');
  await page.waitForSelector('#soloRunButton', { state: 'visible', timeout: 10000 });
  await page.click('#soloRunButton');
  // Control picker may still appear
  const confirmControls = page.locator('#confirmControlsButton, #controlConfirmButton, #controlsContinueButton');
  if (await confirmControls.first().isVisible({ timeout: 1500 }).catch(() => false)) {
    await confirmControls.first().click();
  }
  await page.waitForSelector('#gameScreen:not(.hidden)', { timeout: 15000 });
  await page.waitForSelector('#hudScore', { timeout: 10000 });
  await page.waitForTimeout(800);
  // Force readable sample values
  await page.evaluate(() => {
    const s = document.getElementById('hudScore');
    const l = document.getElementById('hudLevel');
    const h = document.getElementById('hudHighScore');
    const v = document.getElementById('hudLives');
    if (s) s.textContent = '1234';
    if (l) l.textContent = '12';
    if (h) h.textContent = '9999';
    if (v) v.textContent = '3';
  });
  await page.waitForTimeout(200);
}

async function measure(page) {
  return page.evaluate(() => {
    const hud = document.querySelector('.hud');
    const cards = [...document.querySelectorAll('.hud-card')].map((el, i) => {
      const r = el.getBoundingClientRect();
      const p = el.querySelector('p');
      return {
        i,
        id: p && p.id,
        text: p && p.textContent,
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
      };
    });
    const hr = hud.getBoundingClientRect();
    return {
      hud: { w: hr.width, h: hr.height, top: hr.top, left: hr.left, aspect: hr.width / hr.height },
      cards,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = [];

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      ...vp,
      deviceScaleFactor: vp.deviceScaleFactor || 2,
    });
    const page = await context.newPage();
    try {
      await startSolo(page);
      const m = await measure(page);
      const shotPath = path.join(OUT, `${vp.name}.png`);
      const hud = page.locator('.hud');
      await hud.screenshot({ path: shotPath });
      // Also full game top crop
      await page.screenshot({
        path: path.join(OUT, `${vp.name}-full.png`),
        clip: { x: 0, y: 0, width: Math.min(m.viewport.w, page.viewportSize().width), height: Math.min(160, m.viewport.h) },
      });
      report.push({ name: vp.name, ...m, shot: shotPath });
      console.log(vp.name, 'aspect', m.hud.aspect.toFixed(3), 'cards', m.cards.map((c) => c.id + '@' + Math.round((c.cx - m.hud.left) / m.hud.w * 100) + '%').join(', '));
    } catch (err) {
      console.error('FAIL', vp.name, err.message);
      report.push({ name: vp.name, error: err.message });
      await page.screenshot({ path: path.join(OUT, `${vp.name}-error.png`), fullPage: true }).catch(() => {});
    }
    await context.close();
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log('Wrote', OUT);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
