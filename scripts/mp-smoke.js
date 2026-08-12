const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'tmp-hud-shots');
fs.mkdirSync(outDir, { recursive: true });

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
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
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
  await page.waitForFunction(() => {
    const el = document.getElementById('challengeHostCodeDisplay');
    const t = (el && el.textContent) || '';
    return t && !/opening|generating/i.test(t) && t.trim().length >= 4;
  }, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(300);
  const hostText = await page.locator('#challengeOverlay').innerText();
  const hostPanel = await page.locator('#challengeHostPanel').isVisible().catch(() => false);
  const startDisabled = await page.locator('#startHostedRunButton').isDisabled().catch(() => null);
  const codeMatch = hostText.match(/\b[A-Z0-9]{5,8}\b/);
  await page.screenshot({ path: path.join(outDir, 'challenge-overlay.png') });

  await page.click('#challengeTabJoin');
  await page.waitForTimeout(250);
  const joinVisible = await page.locator('#challengeJoinPanel').isVisible().catch(() => false);
  await page.screenshot({ path: path.join(outDir, 'challenge-join.png') });

  await page.click('#closeChallengeOverlayButton');
  await page.waitForTimeout(200);
  await page.click('#achievementsButton');
  await page.waitForSelector('#achievementsOverlay:not(.hidden)', { timeout: 10000 });
  await page.click('#achTabStats');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, 'stats-tab.png') });

  console.log(JSON.stringify({
    ver,
    hostPanel,
    joinVisible,
    startDisabled,
    roomCode: codeMatch && codeMatch[0],
    errors: errors.slice(0, 8),
    hostSnippet: hostText.slice(0, 400)
  }, null, 2));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
