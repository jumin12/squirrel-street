const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'tmp-hud-shots');
fs.mkdirSync(outDir, { recursive: true });

const PORT = process.env.SMOKE_PORT || '8765';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem('squirrelStreet.controlType', 'dpad');
    localStorage.setItem('squirrelStreet.hasSelectedControls', '1');
    localStorage.setItem('squirrelStreet.lastSeenVersion', '99.99');
  });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#continueButton', { state: 'visible', timeout: 90000 });
  await page.click('#continueButton');
  await page.waitForSelector('#usernameOverlay:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, 'username-overlay.png') });
  const usernameVisible = await page.locator('#usernameOverlay:not(.hidden)').isVisible();
  const smokeName = 'Smoke' + Math.floor(Math.random() * 9000 + 1000);
  await page.fill('#usernameOverlayInput', smokeName);
  await page.click('#usernameOverlaySaveButton');
  await page.waitForSelector('#usernameOverlay.hidden, #usernameOverlay.hidden', { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => {
    const el = document.getElementById('usernameOverlay');
    return el && el.classList.contains('hidden');
  }, { timeout: 15000 });
  await page.waitForSelector('#playButton', { state: 'visible' });
  const ver = await page.locator('#screenVersion').textContent();

  await page.click('#playButton');
  await page.waitForSelector('#playModeOverlay:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outDir, 'play-mode.png') });

  await page.click('#challengeModeMenuButton');
  await page.waitForSelector('#challengeOverlay:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(400);
  const overlayText = await page.locator('#challengeOverlay').innerText();
  const findMatch = await page.locator('#challengeFindMatchButton').isVisible().catch(() => false);
  const historyBtn = await page.locator('#challengeHistoryButton').isVisible().catch(() => false);
  await page.screenshot({ path: path.join(outDir, 'challenge-overlay.png') });

  await page.click('#challengeHistoryButton');
  await page.waitForSelector('#challengeHistoryOverlay:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(500);
  const historyText = await page.locator('#challengeHistoryOverlay').innerText();
  await page.screenshot({ path: path.join(outDir, 'challenge-history.png') });

  console.log(JSON.stringify({
    ver,
    usernameVisible,
    smokeName,
    findMatch,
    historyBtn,
    historySnippet: historyText.slice(0, 300),
    errors: errors.slice(0, 8),
    overlaySnippet: overlayText.slice(0, 400)
  }, null, 2));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
