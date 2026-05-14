/**
 * 1) Applies VERSION_CODE / VERSION_NAME from play-store-version.properties to the Capacitor
 *    Android app's android/app/build.gradle (or .kts). Play Console reads versionCode from there —
 *    npm run android:sync does not do this by itself.
 * 2) Runs Capacitor sync in the Android wrapper project.
 *
 * Use: npm run android:sync (from repo root).
 *
 * If your Capacitor folder lives elsewhere, set CAPACITOR_ANDROID_ROOT to that directory
 * (the folder that contains android/ and capacitor.config.*).
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

function parseVersionProps(content) {
  const code = content.match(/^VERSION_CODE\s*=\s*(\d+)\s*$/m);
  const name = content.match(/^VERSION_NAME\s*=\s*(.+)\s*$/m);
  return {
    versionCode: code ? parseInt(code[1], 10) : null,
    versionName: name ? name[1].trim() : null
  };
}

function patchGradleFile(filePath, versionCode, versionName) {
  let s = fs.readFileSync(filePath, 'utf8');
  const orig = s;
  // Groovy (typical Capacitor template)
  s = s.replace(/versionCode\s+\d+/g, `versionCode ${versionCode}`);
  s = s.replace(/versionName\s+"[^"]*"/g, `versionName "${versionName}"`);
  s = s.replace(/versionName\s+'[^']*'/g, `versionName "${versionName}"`);
  // Kotlin DSL
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
        `Copy web assets into your project first, or set CAPACITOR_ANDROID_ROOT to your Capacitor root.`
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

applyPlayVersionsToAndroidProject();

const result = spawnSync('npx', ['cap', 'sync', 'android'], {
  cwd: capRoot,
  stdio: 'inherit',
  shell: true
});

process.exit(result.status === null ? 1 : result.status);
