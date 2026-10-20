import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const runtimeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceDirectory = path.resolve(runtimeDirectory, '../..');

it('resolves public package types in a pnpm consumer without declaring Node types', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-package-types-'));
    try {
        const packageDirectory = path.join(temporaryDirectory, 'package');
        const consumerDirectory = path.join(temporaryDirectory, 'consumer');
        fs.mkdirSync(packageDirectory);
        fs.mkdirSync(path.join(consumerDirectory, 'src'), { recursive: true });

        const runtimeManifest = JSON.parse(fs.readFileSync(path.join(runtimeDirectory, 'package.json'), 'utf8'));
        execFileSync('pnpm', ['pack', '--ignore-scripts', '--pack-destination', packageDirectory], {
            cwd: runtimeDirectory,
            stdio: 'pipe',
        });

        const packageSlug = runtimeManifest.name.replace(/^@/, '').replace('/', '-');
        const tarball = path.join(packageDirectory, `${packageSlug}-${runtimeManifest.version}.tgz`);
        fs.writeFileSync(
            path.join(consumerDirectory, 'package.json'),
            JSON.stringify({
                name: 'static-hermes-package-types-consumer',
                private: true,
                type: 'module',
                dependencies: { [runtimeManifest.name]: `file:${tarball}` },
            }),
        );
        fs.writeFileSync(
            path.join(consumerDirectory, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'ESNext',
                    moduleResolution: 'Bundler',
                    strict: true,
                    noEmit: true,
                    skipLibCheck: true,
                    types: [],
                },
                include: ['src/**/*.ts'],
            }),
        );
        fs.writeFileSync(
            path.join(consumerDirectory, 'src/index.ts'),
            `import { buildHermesArtifacts, setupHermesToolchainEnvironment, staticHermesImportsPlugin } from '${runtimeManifest.name}';\n\nvoid buildHermesArtifacts;\nvoid setupHermesToolchainEnvironment;\nvoid staticHermesImportsPlugin;\n`,
        );

        execFileSync('pnpm', ['install', '--prefer-offline', '--ignore-scripts'], {
            cwd: consumerDirectory,
            stdio: 'pipe',
        });
        expect(fs.existsSync(path.join(consumerDirectory, 'node_modules/@types/node'))).toBe(false);
        const typecheck = spawnSync(
            'pnpm',
            ['exec', 'tsc', '--project', path.join(consumerDirectory, 'tsconfig.json')],
            { cwd: workspaceDirectory, encoding: 'utf8' },
        );
        expect(typecheck.status, `${typecheck.stdout}\n${typecheck.stderr}`).toBe(0);
        execFileSync(
            process.execPath,
            ['--input-type=module', '--eval', `await import(${JSON.stringify(runtimeManifest.name)});`],
            {
                cwd: consumerDirectory,
                stdio: 'pipe',
            },
        );
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}, 60_000);
