import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [path.join(root, 'scripts/collect-plugins.mjs')], {
    cwd: root,
    stdio: 'inherit',
});
