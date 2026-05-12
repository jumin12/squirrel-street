/**
 * Run Capacitor sync from the sibling Android wrapper project.
 * Use: npm run android:sync (from this repo root). Do not run "npx cap" here — this repo has no @capacitor/cli.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const capRoot = path.resolve(
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

const result = spawnSync('npx', ['cap', 'sync', 'android'], {
  cwd: capRoot,
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status === null ? 1 : result.status);
