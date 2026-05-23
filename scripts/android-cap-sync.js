/**
 * Android release pipeline (run from repo root: npm run android:sync)
 *
 * 1) Copies the live web game from THIS repo into the Capacitor project's webDir (www/).
 *    GitHub / Render use index.html here — the Play Store APK does NOT unless you sync.
 * 2) Applies VERSION_CODE / VERSION_NAME from play-store-version.properties to android/app/build.gradle
 * 3) Runs `npx cap sync android` so www/ is bundled into the APK
 *
 * Capacitor root defaults to Desktop/android builds/squirrel street.
 * Override with CAPACITOR_ANDROID_ROOT if yours lives elsewhere.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const propsPath = path.join(repoRoot, 'play-store-version.properties');

const DEFAULT_CAP_ROOT = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'android builds',
  'squirrel street'
);

const capRoot = process.env.CAPACITOR_ANDROID_ROOT
  ? path.resolve(process.env.CAPACITOR_ANDROID_ROOT)
  : DEFAULT_CAP_ROOT;

/** Files and folders shipped inside the APK (must match what www/ already uses). */
const WEB_ASSET_ENTRIES = ['index.html', 'dictionary.js', 'app-ads.txt', 'art', 'sound'];

function parseVersionProps(content) {
  const code = content.match(/^VERSION_CODE\s*=\s*(\d+)\s*$/m);
  const name = content.match(/^VERSION_NAME\s*=\s*(.+)\s*$/m);
  return {
    versionCode: code ? parseInt(code[1], 10) : null,
    versionName: name ? name[1].trim() : null
  };
}

function readWebDir() {
  const cfgPath = path.join(capRoot, 'capacitor.config.json');
  if (!fs.existsSync(cfgPath)) return 'www';
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return cfg.webDir || 'www';
  } catch (e) {
    return 'www';
  }
}

function copyWebAssetsFromRepo() {
  const webDirName = readWebDir();
  const webDir = path.join(capRoot, webDirName);
  fs.mkdirSync(webDir, { recursive: true });

  console.log(`[android-cap-sync] Copying web game from:\n  ${repoRoot}\nto:\n  ${webDir}`);

  for (const entry of WEB_ASSET_ENTRIES) {
    const src = path.join(repoRoot, entry);
    const dest = path.join(webDir, entry);
    if (!fs.existsSync(src)) {
      console.warn(`[android-cap-sync] Skip missing: ${entry}`);
      continue;
    }
    fs.cpSync(src, dest, { recursive: true, force: true });
    console.log(`[android-cap-sync]   copied ${entry}`);
  }

  const indexPath = path.join(webDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    console.error('[android-cap-sync] index.html missing after copy.');
    process.exit(1);
  }
  const html = fs.readFileSync(indexPath, 'utf8');
  const ver = html.match(/const CURRENT_VERSION = '([^']+)'/);
  if (ver) {
    console.log(`[android-cap-sync] Bundled in-game version: v${ver[1]}`);
  } else {
    console.warn('[android-cap-sync] Could not read CURRENT_VERSION from copied index.html');
  }
}

function patchGradleFile(filePath, versionCode, versionName) {
  let s = fs.readFileSync(filePath, 'utf8');
  const orig = s;
  s = s.replace(/versionCode\s+\d+/g, `versionCode ${versionCode}`);
  s = s.replace(/versionName\s+"[^"]*"/g, `versionName "${versionName}"`);
  s = s.replace(/versionName\s+'[^']*'/g, `versionName "${versionName}"`);
  s = s.replace(/versionCode\s*=\s*\d+/g, `versionCode = ${versionCode}`);
  s = s.replace(/versionName\s*=\s*"[^"]*"/g, `versionName = "${versionName}"`);
  if (s === orig) {
    console.warn(
      `[android-cap-sync] No versionCode/versionName lines matched in ${filePath}. Edit that file by hand.`
    );
    return false;
  }
  fs.writeFileSync(filePath, s, 'utf8');
  console.log(`[android-cap-sync] Set versionCode ${versionCode}, versionName "${versionName}" in ${filePath}`);
  return true;
}

function applyPlayVersionsToAndroidProject() {
  if (!fs.existsSync(propsPath)) {
    console.warn(`[android-cap-sync] Missing ${propsPath}`);
    return;
  }
  const props = parseVersionProps(fs.readFileSync(propsPath, 'utf8'));
  if (!props.versionCode || !props.versionName) {
    console.warn('[android-cap-sync] Could not parse VERSION_CODE / VERSION_NAME from play-store-version.properties');
    return;
  }

  const appDir = path.join(capRoot, 'android', 'app');
  const candidates = [
    path.join(appDir, 'build.gradle'),
    path.join(appDir, 'build.gradle.kts')
  ];
  const gradlePath = candidates.find((p) => fs.existsSync(p));
  if (!gradlePath) {
    console.warn(
      `[android-cap-sync] No android/app/build.gradle found under:\n  ${capRoot}\n` +
        `Set CAPACITOR_ANDROID_ROOT to your Capacitor root.`
    );
    return;
  }

  patchGradleFile(gradlePath, props.versionCode, props.versionName);
}

if (!fs.existsSync(capRoot)) {
  console.error(
    `[android-cap-sync] Capacitor root not found:\n  ${capRoot}\n` +
      `Set environment variable CAPACITOR_ANDROID_ROOT to the folder that contains android/ and capacitor.config.*`
  );
  process.exit(1);
}

copyWebAssetsFromRepo();
applyPlayVersionsToAndroidProject();

const result = spawnSync('npx', ['cap', 'sync', 'android'], {
  cwd: capRoot,
  stdio: 'inherit',
  shell: true
});

process.exit(result.status === null ? 1 : result.status);
