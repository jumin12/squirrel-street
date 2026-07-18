const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
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
  await page.waitForSelector('#challengeModeMenuButton', { state: 'visible', timeout: 10000 });
  await page.click('#challengeModeMenuButton');
  await page.waitForSelector('#challengeOverlay:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(600);
  const text = await page.locator('#challengeOverlay').innerText();
  const hostPanel = await page.locator('#challengeHostPanel').isVisible().catch(() => false);
  const codeMatch = text.match(/\b[A-Z0-9]{5,8}\b/);
  await page.screenshot({ path: 'tmp-hud-shots/challenge-overlay.png' });
  console.log(JSON.stringify({ ver, hostPanel, roomCode: codeMatch && codeMatch[0], snippet: text.slice(0, 350) }, null, 2));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
