import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bundlePlugin } from './bundle.ts';
import { executeCli, main, resolveApiWit, run } from './cli.ts';
import { BuildError } from './errors.ts';
import { cacheDir } from './repo.ts';
import { generateTypes } from './types.ts';
import { withFileLock } from './wasi-wit-lock.ts';

vi.mock('./bundle.ts', () => ({ bundlePlugin: vi.fn() }));
vi.mock('./types.ts', () => ({ generateTypes: vi.fn() }));
vi.mock('./wasi-wit.ts', () => ({
    ensureWasiWit: vi.fn(async () => '/unused-wasi-wit'),
    readLock: vi.fn(() => ({ version: '0.2.3', files: {} })),
}));

let sharedWitRepository: { directory: string; branch: string; commit: string };

beforeAll(() => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-wit-repo-'));
    sharedWitRepository = { directory, ...createWitRepository(directory) };
});

afterAll(() => {
    if (sharedWitRepository) fs.rmSync(sharedWitRepository.directory, { recursive: true, force: true });
});

/** Declares the canonical API package, as a plugin must before the build tool resolves it. */
const declaredApi = { dependencies: { '@pumpkin-plugins/pumpkin-api': '0.1.0' } };

function installApiPackage(pluginDir: string, apiDir: string): void {
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(declaredApi));
    writeApiPackageManifest(apiDir);
    writeWitLock(apiDir, sharedWitRepository.directory, sharedWitRepository.branch, sharedWitRepository.commit);
    const scopeDir = path.join(pluginDir, 'node_modules', '@pumpkin-plugins');
    fs.mkdirSync(scopeDir, { recursive: true });
    fs.symlinkSync(apiDir, path.join(scopeDir, 'pumpkin-api'), 'dir');
}

function writeApiPackageManifest(apiDir: string): void {
    fs.writeFileSync(
        path.join(apiDir, 'package.json'),
        JSON.stringify({
            name: '@pumpkin-plugins/pumpkin-api',
            version: '0.1.0',
            exports: { './package.json': './package.json' },
        }),
    );
}

function createWitRepository(
    repositoryDir: string,
    subdirectory = 'v0.1',
    packageVersion = '',
): { branch: string; commit: string } {
    fs.mkdirSync(path.join(repositoryDir, subdirectory), { recursive: true });
    fs.writeFileSync(
        path.join(repositoryDir, subdirectory, 'plugin.wit'),
        `package pumpkin:plugin${packageVersion};\nworld plugin {\n    export run: func();\n}\n`,
    );
    execFileSync('git', ['init', '--quiet', repositoryDir], { stdio: 'ignore' });
    execFileSync('git', ['-C', repositoryDir, 'add', `${subdirectory}/plugin.wit`], { stdio: 'ignore' });
    execFileSync(
        'git',
        [
            '-C',
            repositoryDir,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '--quiet',
            '-m',
            'pin WIT',
        ],
        { stdio: 'ignore' },
    );
    return {
        branch: execFileSync('git', ['-C', repositoryDir, 'branch', '--show-current'], { encoding: 'utf8' }).trim(),
        commit: execFileSync('git', ['-C', repositoryDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    };
}

function commitWitFile(repositoryDir: string, source: string): string {
    fs.writeFileSync(path.join(repositoryDir, 'v0.1', 'plugin.wit'), source);
    execFileSync('git', ['-C', repositoryDir, 'add', 'v0.1/plugin.wit'], { stdio: 'ignore' });
    execFileSync(
        'git',
        [
            '-C',
            repositoryDir,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '--quiet',
            '-m',
            'update WIT',
        ],
        { stdio: 'ignore' },
    );
    return execFileSync('git', ['-C', repositoryDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function writeWitLock(
    apiDir: string,
    repositoryDir: string,
    branch: string,
    commit: string,
    subdirectory = 'v0.1',
): string {
    const lock = `${JSON.stringify(
        {
            $schema:
                'https://raw.githubusercontent.com/filiphsps/pumpkin-plugins/master/tools/pumpkin-api/schemas/upstream-git-pin.schema.json',
            repository: pathToFileURL(repositoryDir).href,
            branch,
            commit,
            subdirectory,
        },
        null,
        4,
    )}\n`;
    fs.writeFileSync(path.join(apiDir, 'wit.lock.json'), lock);
    return lock;
}

function cachedWitDir(pluginDir: string, lock: string): string {
    const lockDigest = createHash('sha256').update(lock).digest('hex');
    const { subdirectory } = JSON.parse(lock) as { subdirectory: string };
    return path.join(cacheDir(pluginDir), 'pumpkin-api-wit', lockDigest, subdirectory);
}

describe('CLI informational options', () => {
    it.each(['--help', '-h'])('prints help for %s without reading plugin configuration', async (argument) => {
        const output: string[] = [];
        vi.mocked(bundlePlugin).mockClear();
        vi.mocked(generateTypes).mockClear();
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            output.push(String(chunk));
            return true;
        });
        try {
            await expect(run([argument], '/not-a-package')).resolves.toBeUndefined();
            expect(output.join('')).toContain('Usage: pumpkin-plugins-build');
            expect(output.join('')).toContain('--types-only');
            expect(output.join('')).toContain('--parse-ts');
            expect(output.join('')).toContain('--no-update-notifier');
            expect(bundlePlugin).not.toHaveBeenCalled();
            expect(generateTypes).not.toHaveBeenCalled();
        } finally {
            stdout.mockRestore();
        }
    });

    it('prints the installed build tool version without reading plugin configuration', async () => {
        const output: string[] = [];
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            output.push(String(chunk));
            return true;
        });
        try {
            await expect(run(['--version'], '/not-a-package')).resolves.toBeUndefined();
            expect(output.join('').trim()).toBe(
                JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
            );
        } finally {
            stdout.mockRestore();
        }
    });

    it('rejects unexpected positional arguments before reading configuration', async () => {
        await expect(run(['another-plugin'], '/not-a-package')).rejects.toThrow(/too many arguments/);
    });
});

describe('executeCli', () => {
    it('runs the build while the update lookup is still pending', async () => {
        const output: string[] = [];
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            output.push(String(chunk));
            return true;
        });
        let finishLookup = (): void => {};
        const lookup = new Promise<void>((resolve) => {
            finishLookup = resolve;
        });
        try {
            const execution = executeCli(['--version'], '/not-a-package', {
                environment: {},
                isTTY: true,
                startUpdateCheck: () => lookup,
            });
            await vi.waitFor(() => expect(output.join('').trim()).toMatch(/^\d+\.\d+\.\d+/));
            finishLookup();
            await expect(execution).resolves.toBeUndefined();
        } finally {
            finishLookup();
            stdout.mockRestore();
        }
    });
});

describe('run arguments', () => {
    it('fetches the explicitly selected upstream WIT version directory', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-versioned-wit-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        const repositoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-wit-repo-'));
        const pin = createWitRepository(repositoryDir, 'v0.2', '@0.2.0');
        writeApiPackageManifest(apiDir);
        const lock = writeWitLock(apiDir, repositoryDir, pin.branch, pin.commit, 'v0.2');
        const scopeDir = path.join(pluginDir, 'node_modules', '@pumpkin-plugins');
        fs.mkdirSync(scopeDir, { recursive: true });
        fs.symlinkSync(apiDir, path.join(scopeDir, 'pumpkin-api'), 'dir');
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({ ...declaredApi, version: '1.0.0', pumpkinPlugin: { wasi: [] } }),
        );
        vi.mocked(generateTypes).mockClear();

        try {
            await run(['--types-only'], pluginDir);

            const cachedWit = cachedWitDir(pluginDir, lock);
            expect(fs.readFileSync(path.join(cachedWit, 'plugin.wit'), 'utf8')).toContain(
                'package pumpkin:plugin@0.2.0',
            );
            expect(generateTypes).toHaveBeenCalledWith(cachedWit, path.join(pluginDir, 'build', 'types', 'bindings'));
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
            fs.rmSync(repositoryDir, { recursive: true, force: true });
        }
    });

    it('fetches the API WIT at its locked commit into the consumer cache', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-pinned-wit-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        const repositoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-wit-repo-'));
        const pin = createWitRepository(repositoryDir);
        writeApiPackageManifest(apiDir);
        const lock = writeWitLock(apiDir, repositoryDir, pin.branch, pin.commit);
        const scopeDir = path.join(pluginDir, 'node_modules', '@pumpkin-plugins');
        fs.mkdirSync(scopeDir, { recursive: true });
        fs.symlinkSync(apiDir, path.join(scopeDir, 'pumpkin-api'), 'dir');
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({ ...declaredApi, version: '1.0.0', pumpkinPlugin: { wasi: [] } }),
        );
        vi.mocked(generateTypes).mockClear();

        try {
            await run(['--types-only'], pluginDir);

            const cachedWit = cachedWitDir(pluginDir, lock);
            expect(fs.readFileSync(path.join(cachedWit, 'plugin.wit'), 'utf8')).toContain('export run: func()');
            expect(cachedWit).not.toContain(path.join(pluginDir, 'node_modules'));
            expect(generateTypes).toHaveBeenCalledWith(cachedWit, path.join(pluginDir, 'build', 'types', 'bindings'));

            fs.rmSync(repositoryDir, { recursive: true, force: true });
            expect(resolveApiWit(pluginDir)).toBe(cachedWit);
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
            fs.rmSync(repositoryDir, { recursive: true, force: true });
        }
    });

    it('uses the consumer API alias when the canonical package only exists under the builder', () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-api-alias-'));
        const aliasApiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-alias-'));
        const builderApiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-builder-'));
        const repositoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-wit-repo-'));
        const aliasPin = createWitRepository(repositoryDir, 'v0.1', '@0.1.0');
        const builderCommit = commitWitFile(
            repositoryDir,
            'package pumpkin:plugin@0.2.0;\nworld plugin {\n    export run: func();\n}\n',
        );
        writeApiPackageManifest(aliasApiDir);
        const aliasLock = writeWitLock(aliasApiDir, repositoryDir, aliasPin.branch, aliasPin.commit);
        writeApiPackageManifest(builderApiDir);
        writeWitLock(builderApiDir, repositoryDir, aliasPin.branch, builderCommit);

        const nodeModulesDir = path.join(pluginDir, 'node_modules');
        const aliasScopeDir = path.join(nodeModulesDir, '@pumpkinmc');
        fs.mkdirSync(aliasScopeDir, { recursive: true });
        fs.symlinkSync(aliasApiDir, path.join(aliasScopeDir, 'pumpkin-api-ts'), 'dir');

        const builderDir = path.join(
            nodeModulesDir,
            '.pnpm',
            '@pumpkin-plugins+build@0.1.0',
            'node_modules',
            '@pumpkin-plugins',
            'build',
        );
        const builderApiScopeDir = path.join(builderDir, 'node_modules', '@pumpkin-plugins');
        fs.mkdirSync(builderApiScopeDir, { recursive: true });
        fs.symlinkSync(builderApiDir, path.join(builderApiScopeDir, 'pumpkin-api'), 'dir');
        const canonicalScopeDir = path.join(nodeModulesDir, '@pumpkin-plugins');
        fs.mkdirSync(canonicalScopeDir, { recursive: true });
        fs.symlinkSync(builderDir, path.join(canonicalScopeDir, 'build'), 'dir');
        expect(fs.existsSync(path.join(canonicalScopeDir, 'pumpkin-api'))).toBe(false);
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                dependencies: {
                    '@pumpkinmc/pumpkin-api-ts': 'npm:@pumpkin-plugins/pumpkin-api@^0.1.0',
                    '@pumpkin-plugins/build': '0.1.0',
                },
            }),
        );

        try {
            const cliUrl = pathToFileURL(fileURLToPath(new URL('./cli.ts', import.meta.url))).href;
            const script = `
                import { resolveApiWit } from ${JSON.stringify(cliUrl)};
                console.log(resolveApiWit(${JSON.stringify(pluginDir)}));
            `;
            const result = spawnSync(
                process.execPath,
                ['--experimental-strip-types', '--input-type=module', '-e', script],
                {
                    cwd: pluginDir,
                    encoding: 'utf8',
                    env: { ...process.env, NODE_PATH: '' },
                },
            );
            expect(result.error).toBeUndefined();
            expect(result.status, result.stderr).toBe(0);
            const witDir = result.stdout.trim();

            expect(witDir).toBe(cachedWitDir(pluginDir, aliasLock));
            expect(fs.readFileSync(path.join(witDir, 'plugin.wit'), 'utf8')).toContain('package pumpkin:plugin@0.1.0');
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(aliasApiDir, { recursive: true, force: true });
            fs.rmSync(builderApiDir, { recursive: true, force: true });
            fs.rmSync(repositoryDir, { recursive: true, force: true });
        }
    }, 30_000);

    it('prefers a directly installed API package when a pnpm alias is also declared', () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-api-alias-precedence-'));
        const canonicalApiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-canonical-'));
        const aliasApiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-alias-'));
        const repositoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-wit-repo-'));
        const canonicalPin = createWitRepository(repositoryDir, 'v0.1', '@0.1.0');
        const aliasCommit = commitWitFile(
            repositoryDir,
            'package pumpkin:plugin@0.2.0;\nworld plugin {\n    export run: func();\n}\n',
        );
        writeApiPackageManifest(canonicalApiDir);
        const canonicalLock = writeWitLock(canonicalApiDir, repositoryDir, canonicalPin.branch, canonicalPin.commit);
        writeApiPackageManifest(aliasApiDir);
        writeWitLock(aliasApiDir, repositoryDir, canonicalPin.branch, aliasCommit);

        const canonicalScopeDir = path.join(pluginDir, 'node_modules', '@pumpkin-plugins');
        const aliasScopeDir = path.join(pluginDir, 'node_modules', '@pumpkinmc');
        fs.mkdirSync(canonicalScopeDir, { recursive: true });
        fs.mkdirSync(aliasScopeDir, { recursive: true });
        fs.symlinkSync(canonicalApiDir, path.join(canonicalScopeDir, 'pumpkin-api'), 'dir');
        fs.symlinkSync(aliasApiDir, path.join(aliasScopeDir, 'pumpkin-api-ts'), 'dir');
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                dependencies: {
                    '@pumpkin-plugins/pumpkin-api': '0.1.0',
                    '@pumpkinmc/pumpkin-api-ts': 'npm:@pumpkin-plugins/pumpkin-api@^0.1.0',
                },
            }),
        );

        try {
            const witDir = resolveApiWit(pluginDir);

            expect(witDir).toBe(cachedWitDir(pluginDir, canonicalLock));
            expect(fs.readFileSync(path.join(witDir, 'plugin.wit'), 'utf8')).toContain('package pumpkin:plugin@0.1.0');
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(canonicalApiDir, { recursive: true, force: true });
            fs.rmSync(aliasApiDir, { recursive: true, force: true });
            fs.rmSync(repositoryDir, { recursive: true, force: true });
        }
    });

    it('tries every declared scoped API alias before a hoisted undeclared canonical package', () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-hoisted-api-alias-'));
        const canonicalApiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-canonical-transitive-'));
        const aliasApiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-alias-'));
        const repositoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-wit-repo-'));
        const canonicalPin = createWitRepository(repositoryDir, 'v0.1', '@0.1.0');
        const aliasCommit = commitWitFile(
            repositoryDir,
            'package pumpkin:plugin@0.2.0;\nworld plugin {\n    export run: func();\n}\n',
        );
        writeApiPackageManifest(canonicalApiDir);
        writeWitLock(canonicalApiDir, repositoryDir, canonicalPin.branch, canonicalPin.commit);
        writeApiPackageManifest(aliasApiDir);
        const aliasLock = writeWitLock(aliasApiDir, repositoryDir, canonicalPin.branch, aliasCommit);

        const canonicalScopeDir = path.join(pluginDir, 'node_modules', '@pumpkin-plugins');
        const aliasScopeDir = path.join(pluginDir, 'node_modules', '@pumpkinmc');
        fs.mkdirSync(canonicalScopeDir, { recursive: true });
        fs.mkdirSync(aliasScopeDir, { recursive: true });
        fs.symlinkSync(canonicalApiDir, path.join(canonicalScopeDir, 'pumpkin-api'), 'dir');
        fs.symlinkSync(aliasApiDir, path.join(aliasScopeDir, 'pumpkin-api-ts'), 'dir');
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                dependencies: {
                    '@pumpkin-plugins/build': '0.1.0',
                    '@missing/pumpkin-api': 'npm:@pumpkin-plugins/pumpkin-api@^0.1.0',
                    '@pumpkinmc/pumpkin-api-ts': 'npm:@pumpkin-plugins/pumpkin-api@^0.1.0',
                },
            }),
        );

        try {
            const witDir = resolveApiWit(pluginDir);

            expect(witDir).toBe(cachedWitDir(pluginDir, aliasLock));
            expect(fs.readFileSync(path.join(witDir, 'plugin.wit'), 'utf8')).toContain('package pumpkin:plugin@0.2.0');
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(canonicalApiDir, { recursive: true, force: true });
            fs.rmSync(aliasApiDir, { recursive: true, force: true });
            fs.rmSync(repositoryDir, { recursive: true, force: true });
        }
    });

    it('fetches a new WIT cache after the lock commit changes', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-wit-refresh-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        const repositoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-wit-repo-'));
        const pin = createWitRepository(repositoryDir);
        writeApiPackageManifest(apiDir);
        const firstLock = writeWitLock(apiDir, repositoryDir, pin.branch, pin.commit);
        const scopeDir = path.join(pluginDir, 'node_modules', '@pumpkin-plugins');
        fs.mkdirSync(scopeDir, { recursive: true });
        fs.symlinkSync(apiDir, path.join(scopeDir, 'pumpkin-api'), 'dir');
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({ ...declaredApi, version: '1.0.0', pumpkinPlugin: { wasi: [] } }),
        );
        vi.mocked(generateTypes).mockClear();

        try {
            await run(['--types-only'], pluginDir);
            const firstWit = vi.mocked(generateTypes).mock.calls[0]?.[0];
            if (!firstWit) throw new Error('initial WIT was not passed to type generation');
            expect(fs.readFileSync(path.join(firstWit, 'plugin.wit'), 'utf8')).toContain('export run: func()');

            const secondCommit = commitWitFile(
                repositoryDir,
                'package pumpkin:plugin;\nworld plugin {\n    export stop: func();\n}\n',
            );
            const secondLock = writeWitLock(apiDir, repositoryDir, pin.branch, secondCommit);
            await run(['--types-only'], pluginDir);

            const secondWit = vi.mocked(generateTypes).mock.calls[1]?.[0];
            expect(secondWit).not.toBe(firstWit);
            expect(secondWit).toBe(cachedWitDir(pluginDir, secondLock));
            expect(fs.readFileSync(path.join(secondWit, 'plugin.wit'), 'utf8')).toContain('export stop: func()');
            expect(createHash('sha256').update(firstLock).digest('hex')).not.toBe(
                createHash('sha256').update(secondLock).digest('hex'),
            );
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
            fs.rmSync(repositoryDir, { recursive: true, force: true });
        }
    });

    it('rejects unsupported arguments before reading package configuration', async () => {
        await expect(run(['--types-onyl'], '/not-a-package')).rejects.toThrow(BuildError);
        await expect(run(['--types-onyl'], '/not-a-package')).rejects.toThrow("unknown option '--types-onyl'");
    });

    it('rejects TypeScript parsing for QuickJS before resolving build dependencies', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-parse-ts-quickjs-'));
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                version: '1.0.0',
                pumpkinPlugin: {
                    entry: 'src/plugin.ts',
                    output: 'build/plugin.wasm',
                    wasi: [],
                    engine: 'quickjs',
                },
            }),
        );

        try {
            await expect(run(['--parse-ts'], pluginDir)).rejects.toThrow('--parse-ts requires Static Hermes');
            expect(bundlePlugin).not.toHaveBeenCalled();
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
        }
    });

    it('reports missing build fields before resolving build dependencies', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-'));
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({ version: '1.0.0', pumpkinPlugin: { wasi: [] } }),
        );

        try {
            await expect(run([], pluginDir)).rejects.toThrow(/entry.*output/);
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
        }
    });

    it('reports when the plugin does not install the Pumpkin API package', () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-missing-api-'));

        try {
            expect(() =>
                resolveApiWit(pluginDir, () => {
                    throw new Error('MODULE_NOT_FOUND');
                }),
            ).toThrow(
                'cannot resolve @pumpkin-plugins/pumpkin-api or its declared package alias from this plugin; add it to the plugin dependencies and run your package manager install',
            );
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
        }
    });

    it('rejects an installed API package that the plugin does not declare', () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-undeclared-api-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        installApiPackage(pluginDir, apiDir);
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({ version: '1.0.0', pumpkinPlugin: { wasi: [] } }),
        );

        try {
            expect(() => resolveApiWit(pluginDir)).toThrow(/add it to the plugin dependencies/);
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it('reports a malformed Pumpkin API package without WIT inputs', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-malformed-api-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        writeApiPackageManifest(apiDir);
        const scopeDir = path.join(pluginDir, 'node_modules', '@pumpkin-plugins');
        fs.mkdirSync(scopeDir, { recursive: true });
        fs.symlinkSync(apiDir, path.join(scopeDir, 'pumpkin-api'), 'dir');
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({ ...declaredApi, version: '1.0.0', pumpkinPlugin: { wasi: [] } }),
        );

        try {
            await expect(run(['--types-only'], pluginDir)).rejects.toThrow(/WIT lockfile not found/);
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it('reports malformed WIT lock JSON with its package path', () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-invalid-api-lock-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        writeApiPackageManifest(apiDir);
        fs.writeFileSync(path.join(apiDir, 'wit.lock.json'), '{ invalid json');
        const scopeDir = path.join(pluginDir, 'node_modules', '@pumpkin-plugins');
        fs.mkdirSync(scopeDir, { recursive: true });
        fs.symlinkSync(apiDir, path.join(scopeDir, 'pumpkin-api'), 'dir');
        fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(declaredApi));

        try {
            expect(() => resolveApiWit(pluginDir)).toThrow(/WIT lockfile is invalid JSON.*wit\.lock\.json/);
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it('reports actionable errors when the pinned WIT commit cannot be fetched', () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-unavailable-wit-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        writeApiPackageManifest(apiDir);
        writeWitLock(apiDir, sharedWitRepository.directory, sharedWitRepository.branch, '0'.repeat(40));
        const scopeDir = path.join(pluginDir, 'node_modules', '@pumpkin-plugins');
        fs.mkdirSync(scopeDir, { recursive: true });
        fs.symlinkSync(apiDir, path.join(scopeDir, 'pumpkin-api'), 'dir');
        fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(declaredApi));

        try {
            expect(() => resolveApiWit(pluginDir)).toThrow(
                /could not resolve pinned WIT.*could not fetch Pumpkin WIT.*first build after a lock change needs Git and network access/,
            );
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it.each(['node_modules/.cache', '.pnpm-store/cache', 'pnpm/store'])(
        'rejects a Pumpkin WIT cache override in %s',
        (relativeCachePath) => {
            const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-wit-cache-location-'));
            const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
            installApiPackage(pluginDir, apiDir);
            const previousCache = process.env.PUMPKIN_PLUGINS_CACHE_DIR;
            process.env.PUMPKIN_PLUGINS_CACHE_DIR = path.join(pluginDir, relativeCachePath);

            try {
                expect(() => resolveApiWit(pluginDir)).toThrow(
                    /cache must stay outside node_modules and the pnpm store/,
                );
            } finally {
                if (previousCache === undefined) delete process.env.PUMPKIN_PLUGINS_CACHE_DIR;
                else process.env.PUMPKIN_PLUGINS_CACHE_DIR = previousCache;
                fs.rmSync(pluginDir, { recursive: true, force: true });
                fs.rmSync(apiDir, { recursive: true, force: true });
            }
        },
    );

    it('generates guest types without requiring a plugin entry point or output', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-types-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        installApiPackage(pluginDir, apiDir);
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({ ...declaredApi, version: '1.0.0', pumpkinPlugin: { wasi: [] } }),
        );
        vi.mocked(generateTypes).mockClear();

        try {
            await run(['--types-only'], pluginDir);
            const lock = fs.readFileSync(path.join(apiDir, 'wit.lock.json'), 'utf8');
            expect(generateTypes).toHaveBeenCalledWith(
                cachedWitDir(pluginDir, lock),
                path.join(pluginDir, 'build', 'types', 'bindings'),
            );
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it('does not keep a second WIT copy under build/types after generating WASI declarations', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-types-wasi-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        installApiPackage(pluginDir, apiDir);
        let generatedFrom = '';
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({ ...declaredApi, version: '1.0.0', pumpkinPlugin: { wasi: ['http'] } }),
        );
        vi.mocked(generateTypes)
            .mockReset()
            .mockImplementation((witDir) => {
                generatedFrom = witDir;
                expect(fs.readFileSync(path.join(witDir, 'plugin.wit'), 'utf8')).toContain(
                    'import wasi:http/types@0.2.3;',
                );
            });

        try {
            await run(['--types-only'], pluginDir);

            expect(generateTypes).toHaveBeenCalledTimes(1);
            expect(generatedFrom).not.toBe('');
            expect(generatedFrom).not.toContain(path.join(pluginDir, 'build'));
            expect(fs.existsSync(generatedFrom)).toBe(false);
            expect(fs.existsSync(path.join(pluginDir, 'build', 'types', 'wit'))).toBe(false);
        } finally {
            vi.mocked(generateTypes).mockReset();
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it('builds the configured entry and reports the output size', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-build-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        installApiPackage(pluginDir, apiDir);
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                ...declaredApi,
                version: '1.2.3',
                pumpkinPlugin: {
                    entry: 'src/plugin.ts',
                    output: 'build/plugin.wasm',
                    wasi: [],
                    engine: 'static-hermes',
                    staticHermesRuntime: 'lean',
                },
            }),
        );
        vi.mocked(bundlePlugin)
            .mockClear()
            .mockImplementationOnce(async (options) => {
                options.onOutput?.({
                    type: 'componentize',
                    engine: 'static-hermes',
                    runtimeVariant: 'lean',
                    gcVariant: options.staticHermesGc,
                    parseTypeScript: options.parseTypeScript,
                });
                return 2048;
            });
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            await run(['--parse-ts'], pluginDir);

            expect(bundlePlugin).toHaveBeenCalledWith({
                projectRoot: pluginDir,
                entry: path.join(pluginDir, 'src/plugin.ts'),
                output: path.join(pluginDir, 'build/plugin.wasm'),
                witDir: cachedWitDir(pluginDir, fs.readFileSync(path.join(apiDir, 'wit.lock.json'), 'utf8')),
                version: '1.2.3',
                engine: 'static-hermes',
                staticHermesRuntime: 'lean',
                staticHermesGc: 'hades',
                parseTypeScript: true,
                developmentMode: false,
                quietRuntimeOutput: true,
                onOutput: expect.any(Function),
            });
            expect(consoleLog.mock.calls.map(([message]) => message)).toEqual([
                '[build] Bundling \u001b[36msrc/plugin.ts\u001b[0m with \u001b[36mStatic Hermes (lean, hades, TS parser)\u001b[0m...',
                '[build] Componentizing with \u001b[36mStatic Hermes (lean, hades, TS parser)\u001b[0m...',
                '[build] Built \u001b[36mbuild/plugin.wasm\u001b[0m (\u001b[94m2 KiB\u001b[0m)',
            ]);
        } finally {
            consoleLog.mockRestore();
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it('shows runtime tool output when verbose build logs are enabled', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-verbose-build-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        const previousVerboseBuild = process.env.PUMPKIN_PLUGINS_VERBOSE_BUILD;
        installApiPackage(pluginDir, apiDir);
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                ...declaredApi,
                version: '1.2.3',
                pumpkinPlugin: {
                    entry: 'src/plugin.ts',
                    output: 'build/plugin.wasm',
                    wasi: [],
                    engine: 'static-hermes',
                },
            }),
        );
        process.env.PUMPKIN_PLUGINS_VERBOSE_BUILD = '1';
        vi.mocked(bundlePlugin)
            .mockClear()
            .mockImplementationOnce(async () => 2048);
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            await run([], pluginDir);

            expect(bundlePlugin).toHaveBeenCalledWith(
                expect.objectContaining({
                    quietRuntimeOutput: false,
                }),
            );
        } finally {
            consoleLog.mockRestore();
            if (previousVerboseBuild === undefined) delete process.env.PUMPKIN_PLUGINS_VERBOSE_BUILD;
            else process.env.PUMPKIN_PLUGINS_VERBOSE_BUILD = previousVerboseBuild;
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it('removes the published WIT snapshot after a build no longer imports WASI', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-wit-no-wasi-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        installApiPackage(pluginDir, apiDir);
        const manifest = {
            ...declaredApi,
            version: '1.2.3',
            pumpkinPlugin: {
                entry: 'src/plugin.ts',
                output: 'build/plugin.wasm',
                wasi: ['http'],
            },
        };
        fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(manifest));
        vi.mocked(bundlePlugin).mockReset().mockResolvedValue(1);
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
        let releasePublication = () => {};
        let activePublisher: Promise<void> | undefined;
        let noWasiBuild: Promise<void> | undefined;

        try {
            await run([], pluginDir);

            const snapshot = path.join(pluginDir, 'build', 'wit');
            expect(fs.readFileSync(path.join(snapshot, 'plugin.wit'), 'utf8')).toContain(
                'import wasi:http/types@0.2.3;',
            );

            const publicationLock = path.join(pluginDir, 'build', '.wit-publish.lock');
            let signalPublication = () => {};
            const publicationStarted = new Promise<void>((resolve) => {
                signalPublication = resolve;
            });
            const publicationGate = new Promise<void>((resolve) => {
                releasePublication = resolve;
            });
            activePublisher = withFileLock(publicationLock, async () => {
                signalPublication();
                await publicationGate;
            });
            await publicationStarted;

            manifest.pumpkinPlugin.wasi = [];
            fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(manifest));
            let noWasiBuildFinished = false;
            noWasiBuild = run([], pluginDir).then(() => {
                noWasiBuildFinished = true;
            });
            await new Promise<void>((resolve) => setTimeout(resolve, 50));

            expect(noWasiBuildFinished).toBe(false);
            expect(fs.existsSync(snapshot)).toBe(true);

            releasePublication();
            await activePublisher;
            await noWasiBuild;

            expect(fs.existsSync(snapshot)).toBe(false);
        } finally {
            releasePublication();
            if (activePublisher) await activePublisher.catch(() => {});
            if (noWasiBuild) await noWasiBuild.catch(() => {});
            consoleLog.mockRestore();
            vi.mocked(bundlePlugin).mockReset();
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it('keeps a running build on its WIT snapshot while a concurrent build publishes newer WIT', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-concurrent-wit-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        const repositoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-wit-repo-'));
        const pin = createWitRepository(repositoryDir);
        writeApiPackageManifest(apiDir);
        writeWitLock(apiDir, repositoryDir, pin.branch, pin.commit);
        const scopeDir = path.join(pluginDir, 'node_modules', '@pumpkin-plugins');
        fs.mkdirSync(scopeDir, { recursive: true });
        fs.symlinkSync(apiDir, path.join(scopeDir, 'pumpkin-api'), 'dir');
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                ...declaredApi,
                version: '1.2.3',
                pumpkinPlugin: {
                    entry: 'src/plugin.ts',
                    output: 'build/plugin.wasm',
                    wasi: ['http'],
                },
            }),
        );

        let releaseFirstBuild = () => {};
        const firstBuildGate = new Promise<void>((resolve) => {
            releaseFirstBuild = resolve;
        });
        let signalFirstBuild = () => {};
        const firstBuildStarted = new Promise<void>((resolve) => {
            signalFirstBuild = resolve;
        });
        const observedWit: string[] = [];
        vi.mocked(bundlePlugin)
            .mockReset()
            .mockImplementationOnce(async ({ witDir }) => {
                signalFirstBuild();
                await firstBuildGate;
                observedWit[0] = fs.readFileSync(path.join(witDir, 'plugin.wit'), 'utf8');
                return 1;
            })
            .mockImplementationOnce(async ({ witDir }) => {
                observedWit[1] = fs.readFileSync(path.join(witDir, 'plugin.wit'), 'utf8');
                return 1;
            });

        let firstBuild: Promise<void> | undefined;
        try {
            firstBuild = run([], pluginDir);
            await firstBuildStarted;

            const updatedCommit = commitWitFile(
                repositoryDir,
                'package pumpkin:plugin;\nworld plugin {\n    export stop: func();\n}\n',
            );
            writeWitLock(apiDir, repositoryDir, pin.branch, updatedCommit);
            await run([], pluginDir);

            releaseFirstBuild();
            await firstBuild;

            expect(observedWit[0]).toContain('export run: func();');
            expect(observedWit[0]).not.toContain('export stop: func();');
            expect(observedWit[1]).toContain('export stop: func();');
            expect(fs.readFileSync(path.join(pluginDir, 'build', 'wit', 'plugin.wit'), 'utf8')).toContain(
                'export stop: func();',
            );
        } finally {
            releaseFirstBuild();
            if (firstBuild) await firstBuild.catch(() => {});
            vi.mocked(bundlePlugin).mockReset();
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
            fs.rmSync(repositoryDir, { recursive: true, force: true });
        }
    });

    it('links the lean Hermes archive by default', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-lean-default-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        installApiPackage(pluginDir, apiDir);
        const previous = {
            lean: process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE,
        };
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                ...declaredApi,
                version: '1.2.3',
                pumpkinPlugin: {
                    entry: 'src/plugin.ts',
                    output: 'build/plugin.wasm',
                    wasi: [],
                    engine: 'static-hermes',
                },
            }),
        );
        delete process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE;
        vi.mocked(bundlePlugin).mockClear().mockResolvedValue(1);
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            await run([], pluginDir);

            expect(bundlePlugin).toHaveBeenCalledWith(
                expect.objectContaining({ engine: 'static-hermes', staticHermesRuntime: 'lean' }),
            );
        } finally {
            consoleLog.mockRestore();
            if (previous.lean === undefined) delete process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE;
            else process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE = previous.lean;
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it('uses the full Hermes archive when the lean profile is disabled', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-full-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        installApiPackage(pluginDir, apiDir);
        const previous = {
            lean: process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE,
        };
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                ...declaredApi,
                version: '1.2.3',
                pumpkinPlugin: {
                    entry: 'src/plugin.ts',
                    output: 'build/plugin.wasm',
                    wasi: [],
                    engine: 'static-hermes',
                },
            }),
        );
        process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE = '0';
        vi.mocked(bundlePlugin).mockClear().mockResolvedValue(1);
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            await run([], pluginDir);

            expect(bundlePlugin).toHaveBeenCalledWith(
                expect.objectContaining({ engine: 'static-hermes', staticHermesRuntime: 'full' }),
            );
        } finally {
            consoleLog.mockRestore();
            if (previous.lean === undefined) delete process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE;
            else process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE = previous.lean;
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it('marks bundles created for pnpm dev as development builds', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-dev-build-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        installApiPackage(pluginDir, apiDir);
        const previous = {
            dev: process.env.PUMPKIN_DEV_MODE,
            lean: process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE,
        };
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                ...declaredApi,
                version: '1.2.3',
                pumpkinPlugin: {
                    entry: 'src/plugin.ts',
                    output: 'build/plugin.wasm',
                    wasi: [],
                    engine: 'static-hermes',
                },
            }),
        );
        process.env.PUMPKIN_DEV_MODE = '1';
        delete process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE;
        vi.mocked(bundlePlugin).mockClear().mockResolvedValue(2048);
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            await run([], pluginDir);

            expect(bundlePlugin).toHaveBeenCalledWith({
                projectRoot: pluginDir,
                entry: path.join(pluginDir, 'src/plugin.ts'),
                output: path.join(pluginDir, 'build/plugin.wasm'),
                witDir: cachedWitDir(pluginDir, fs.readFileSync(path.join(apiDir, 'wit.lock.json'), 'utf8')),
                version: '1.2.3',
                engine: 'static-hermes',
                staticHermesRuntime: 'lean',
                staticHermesGc: 'hades',
                developmentMode: true,
                quietRuntimeOutput: true,
                onOutput: expect.any(Function),
            });
        } finally {
            consoleLog.mockRestore();
            if (previous.dev === undefined) delete process.env.PUMPKIN_DEV_MODE;
            else process.env.PUMPKIN_DEV_MODE = previous.dev;
            if (previous.lean === undefined) delete process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE;
            else process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE = previous.lean;
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });
});

describe('main error handling', () => {
    it('flushes the complete build error before exiting when stderr is piped', () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-large-error-'));
        const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({ version: '1.0.0', pumpkinPlugin: { wasi: ['x'.repeat(1024 * 1024)] } }),
        );

        try {
            const result = spawnSync(process.execPath, [cliPath], {
                cwd: pluginDir,
                encoding: 'utf8',
                maxBuffer: 2 * 1024 * 1024,
            });

            expect(result.error).toBeUndefined();
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('(known: ');
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
        }
    });

    it('prints build errors and sets the exit code to 1', async () => {
        const previousExitCode = process.exitCode;
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const processExit = vi.spyOn(process, 'exit');

        try {
            await expect(main(['--unknown'], '/not-a-package')).resolves.toBeUndefined();
            expect(consoleError).toHaveBeenCalledWith("[build] Error: \u001b[1;31munknown option '--unknown'\u001b[0m");
            expect(process.exitCode).toBe(1);
            expect(processExit).not.toHaveBeenCalled();
        } finally {
            process.exitCode = previousExitCode;
            processExit.mockRestore();
            consoleError.mockRestore();
        }
    });

    it('rethrows unexpected errors without printing a build error', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-error-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        installApiPackage(pluginDir, apiDir);
        const unexpectedError = new Error('componentizer failed');
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                ...declaredApi,
                version: '1.2.3',
                pumpkinPlugin: { entry: 'src/plugin.ts', output: 'build/plugin.wasm', wasi: [] },
            }),
        );
        vi.mocked(bundlePlugin).mockRejectedValue(unexpectedError);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const processExit = vi.spyOn(process, 'exit').mockImplementation(() => {
            throw new Error('unexpected process exit');
        });

        try {
            await expect(main([], pluginDir)).rejects.toBe(unexpectedError);
            expect(consoleError).not.toHaveBeenCalled();
            expect(processExit).not.toHaveBeenCalled();
        } finally {
            processExit.mockRestore();
            consoleError.mockRestore();
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });
});
