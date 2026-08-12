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
  const botEasy = await page.locator('#challengeBotEasyButton').isVisible().catch(() => false);
  const waiting = await page.locator('#challengeWaitingSection').isVisible().catch(() => false);
  const search = await page.locator('#challengePlayerSearchInput').isVisible().catch(() => false);
  const hostTabGone = await page.locator('#challengeTabHost').count();
  const joinTabGone = await page.locator('#challengeTabJoin').count();
  const codeInputGone = await page.locator('#challengeCodeInput').count();
  await page.screenshot({ path: path.join(outDir, 'challenge-overlay.png') });

  await page.click('#closeChallengeOverlayButton');
  await page.waitForTimeout(200);
  await page.click('#achievementsButton');
  await page.waitForSelector('#achievementsOverlay:not(.hidden)', { timeout: 10000 });
  await page.click('#achTabStats');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, 'stats-tab.png') });

  const looksLikeRoomCode = /\bRoom code\b|\bHost\b|\bJoin run\b|\bABC123\b/i.test(overlayText);

  console.log(JSON.stringify({
    ver,
    findMatch,
    botEasy,
    waiting,
    search,
    hostTabGone,
    joinTabGone,
    codeInputGone,
    looksLikeRoomCode,
    errors: errors.slice(0, 8),
    overlaySnippet: overlayText.slice(0, 500)
  }, null, 2));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
