import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const turboPackage = require.resolve('turbo/package.json');
const turboManifest = JSON.parse(fs.readFileSync(turboPackage, 'utf8'));
const turboBin = typeof turboManifest.bin === 'string' ? turboManifest.bin : turboManifest.bin.turbo;
const turbo = path.resolve(path.dirname(turboPackage), turboBin);
execFileSync(process.execPath, [turbo, 'run', 'build'], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [path.join(root, 'scripts/collect-plugins.mjs')], {
    cwd: root,
    stdio: 'inherit'
});
