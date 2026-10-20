import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const extensionRoot = process.cwd();
const manifestPath = path.join(extensionRoot, 'package.json');
const originalManifest = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(originalManifest);

if (Object.keys(manifest.dependencies ?? {}).length > 0) {
    throw new Error(
        'Bundle production dependencies into dist before packaging a VSIX; pnpm dependencies are not copied.',
    );
}

/** Resolves a workspace dependency's installed package version for VSCE's SemVer validator. */
function installedVersion(packageName) {
    const packageFile = path.join(extensionRoot, 'node_modules', ...packageName.split('/'), 'package.json');
    if (!fs.existsSync(packageFile)) throw new Error(`${packageName} is missing from ${extensionRoot}/node_modules`);
    const version = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version;
    if (typeof version !== 'string') throw new Error(`${packageFile} does not declare a version`);
    return version;
}

/** Replaces pnpm-only dependency protocols in a temporary VSCE manifest. */
function normalizeDependencyRanges() {
    for (const field of ['devDependencies', 'optionalDependencies']) {
        const dependencies = manifest[field];
        if (!dependencies || typeof dependencies !== 'object') continue;
        for (const [name, range] of Object.entries(dependencies)) {
            if (typeof range === 'string' && /^(?:catalog:|workspace:)/.test(range)) {
                dependencies[name] = installedVersion(name);
            }
        }
    }
}

// Without a listener, Ctrl+C or SIGTERM ends Node before `finally` restores package.json. vsce gets
// the signal too, so spawnSync returns; after the restore, the signal is raised again to exit.
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => process.kill(process.pid, name));

let exitCode = 0;
try {
    normalizeDependencyRanges();
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
    const vscePath = path.join(extensionRoot, 'node_modules', '.bin', 'vsce');
    const packageArguments = process.argv.slice(2);
    if (packageArguments[0] === '--') packageArguments.shift();
    const result = spawnSync(vscePath, ['package', '--no-yarn', '--no-dependencies', ...packageArguments], {
        cwd: extensionRoot,
        stdio: 'inherit',
        windowsHide: true,
    });
    if (result.error) throw result.error;
    exitCode = result.status ?? 1;
} finally {
    fs.writeFileSync(manifestPath, originalManifest);
}

process.exitCode = exitCode;
