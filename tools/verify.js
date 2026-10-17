'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const file of ['background.js', 'content.js', 'options.js']) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, 'wangke-ext', file)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'wangke-ext', 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
const resources = [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(item => item.js)];
for (const file of resources) {
  if (!fs.existsSync(path.join(root, 'wangke-ext', file))) throw new Error(`Missing resource: ${file}`);
}
console.log(`Syntax passed: 3 JavaScript files; manifest parsed; ${resources.length} resource references exist.`);
