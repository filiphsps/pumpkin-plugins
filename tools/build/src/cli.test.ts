import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bundlePlugin } from './bundle.ts';
import { main, run } from './cli.ts';
import { BuildError } from './errors.ts';
import { generateTypes } from './types.ts';

vi.mock('./bundle.ts', () => ({ bundlePlugin: vi.fn() }));
vi.mock('./types.ts', () => ({ generateTypes: vi.fn() }));
vi.mock('./wasi-wit.ts', () => ({
    ensureWasiWit: vi.fn(async () => '/unused-wasi-wit'),
    readLock: vi.fn(() => ({ version: '0.2.3', files: {} }))
}));

describe('run arguments', () => {
    it('rejects unsupported arguments before reading package configuration', async () => {
        await expect(run(['--types-onyl'], '/not-a-package')).rejects.toThrow(BuildError);
        await expect(run(['--types-onyl'], '/not-a-package')).rejects.toThrow(
            'unknown argument "--types-onyl" (supported: --types-only)'
        );
    });

    it('reports missing build fields before resolving build dependencies', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-'));
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({ version: '1.0.0', pumpkinPlugin: { wasi: [] } })
        );

        try {
            await expect(run([], pluginDir)).rejects.toThrow(/entry.*output/);
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
        }
    });

    it('generates guest types without requiring a plugin entry point or output', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-types-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        const realApiDir = process.env.PUMPKIN_API_DIR;
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({ version: '1.0.0', pumpkinPlugin: { wasi: [] } })
        );
        process.env.PUMPKIN_API_DIR = apiDir;
        vi.mocked(generateTypes).mockClear();

        try {
            await run(['--types-only'], pluginDir);
            expect(generateTypes).toHaveBeenCalledWith(
                path.join(apiDir, 'wit', 'v0.1'),
                path.join(pluginDir, 'build', 'types', 'bindings')
            );
        } finally {
            if (realApiDir === undefined) delete process.env.PUMPKIN_API_DIR;
            else process.env.PUMPKIN_API_DIR = realApiDir;
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it('does not keep a second WIT copy under build/types after generating WASI declarations', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-types-wasi-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        const apiWit = path.join(apiDir, 'wit', 'v0.1');
        const legacyTypesWit = path.join(pluginDir, 'build', 'types', 'wit');
        const realApiDir = process.env.PUMPKIN_API_DIR;
        let generatedFrom = '';
        fs.mkdirSync(apiWit, { recursive: true });
        fs.writeFileSync(
            path.join(apiWit, 'plugin.wit'),
            'package pumpkin:plugin; world plugin {\n    export run: func();\n}\n'
        );
        fs.mkdirSync(legacyTypesWit, { recursive: true });
        fs.writeFileSync(path.join(legacyTypesWit, 'old.wit'), 'stale generated copy');
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({ version: '1.0.0', pumpkinPlugin: { wasi: ['http'] } })
        );
        process.env.PUMPKIN_API_DIR = apiDir;
        vi.mocked(generateTypes)
            .mockReset()
            .mockImplementation((witDir) => {
                generatedFrom = witDir;
                expect(fs.readFileSync(path.join(witDir, 'plugin.wit'), 'utf8')).toContain(
                    'import wasi:http/types@0.2.3;'
                );
            });

        try {
            await run(['--types-only'], pluginDir);

            expect(generateTypes).toHaveBeenCalledTimes(1);
            expect(generatedFrom).not.toBe('');
            expect(generatedFrom).not.toContain(path.join(pluginDir, 'build'));
            expect(fs.existsSync(generatedFrom)).toBe(false);
            expect(fs.existsSync(legacyTypesWit)).toBe(false);
        } finally {
            vi.mocked(generateTypes).mockReset();
            if (realApiDir === undefined) delete process.env.PUMPKIN_API_DIR;
            else process.env.PUMPKIN_API_DIR = realApiDir;
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it('builds the configured entry and reports the output size', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-build-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        const realApiDir = process.env.PUMPKIN_API_DIR;
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                version: '1.2.3',
                pumpkinPlugin: {
                    entry: 'src/plugin.ts',
                    output: 'build/plugin.wasm',
                    wasi: [],
                    engine: 'static-hermes',
                    staticHermesRuntime: 'lean'
                }
            })
        );
        process.env.PUMPKIN_API_DIR = apiDir;
        vi.mocked(bundlePlugin).mockClear().mockResolvedValue(2048);
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            await run([], pluginDir);

            expect(bundlePlugin).toHaveBeenCalledWith({
                entry: path.join(pluginDir, 'src/plugin.ts'),
                output: path.join(pluginDir, 'build/plugin.wasm'),
                witDir: path.join(apiDir, 'wit', 'v0.1'),
                version: '1.2.3',
                engine: 'static-hermes',
                staticHermesRuntime: 'lean',
                developmentMode: false
            });
            expect(consoleLog.mock.calls.map(([message]) => message)).toEqual([
                'Bundling src/plugin.ts...',
                'Built build/plugin.wasm (2 KiB)'
            ]);
        } finally {
            consoleLog.mockRestore();
            if (realApiDir === undefined) delete process.env.PUMPKIN_API_DIR;
            else process.env.PUMPKIN_API_DIR = realApiDir;
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it('links the lean Hermes archive by default', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-lean-default-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        const previous = {
            api: process.env.PUMPKIN_API_DIR,
            lean: process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE
        };
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                version: '1.2.3',
                pumpkinPlugin: {
                    entry: 'src/plugin.ts',
                    output: 'build/plugin.wasm',
                    wasi: [],
                    engine: 'static-hermes'
                }
            })
        );
        process.env.PUMPKIN_API_DIR = apiDir;
        delete process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE;
        vi.mocked(bundlePlugin).mockClear().mockResolvedValue(1);
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            await run([], pluginDir);

            expect(bundlePlugin).toHaveBeenCalledWith(
                expect.objectContaining({ engine: 'static-hermes', staticHermesRuntime: 'lean' })
            );
        } finally {
            consoleLog.mockRestore();
            if (previous.api === undefined) delete process.env.PUMPKIN_API_DIR;
            else process.env.PUMPKIN_API_DIR = previous.api;
            if (previous.lean === undefined) delete process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE;
            else process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE = previous.lean;
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it('uses the full Hermes archive when the lean profile is disabled', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-full-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        const previous = {
            api: process.env.PUMPKIN_API_DIR,
            lean: process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE
        };
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                version: '1.2.3',
                pumpkinPlugin: {
                    entry: 'src/plugin.ts',
                    output: 'build/plugin.wasm',
                    wasi: [],
                    engine: 'static-hermes'
                }
            })
        );
        process.env.PUMPKIN_API_DIR = apiDir;
        process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE = '0';
        vi.mocked(bundlePlugin).mockClear().mockResolvedValue(1);
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            await run([], pluginDir);

            expect(bundlePlugin).toHaveBeenCalledWith(
                expect.objectContaining({ engine: 'static-hermes', staticHermesRuntime: 'full' })
            );
        } finally {
            consoleLog.mockRestore();
            if (previous.api === undefined) delete process.env.PUMPKIN_API_DIR;
            else process.env.PUMPKIN_API_DIR = previous.api;
            if (previous.lean === undefined) delete process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE;
            else process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE = previous.lean;
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });

    it('marks bundles created for pnpm dev as development builds', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-dev-build-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        const previous = {
            api: process.env.PUMPKIN_API_DIR,
            dev: process.env.PUMPKIN_DEV_MODE,
            lean: process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE
        };
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                version: '1.2.3',
                pumpkinPlugin: {
                    entry: 'src/plugin.ts',
                    output: 'build/plugin.wasm',
                    wasi: [],
                    engine: 'static-hermes'
                }
            })
        );
        process.env.PUMPKIN_API_DIR = apiDir;
        process.env.PUMPKIN_DEV_MODE = '1';
        delete process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE;
        vi.mocked(bundlePlugin).mockClear().mockResolvedValue(2048);
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            await run([], pluginDir);

            expect(bundlePlugin).toHaveBeenCalledWith({
                entry: path.join(pluginDir, 'src/plugin.ts'),
                output: path.join(pluginDir, 'build/plugin.wasm'),
                witDir: path.join(apiDir, 'wit', 'v0.1'),
                version: '1.2.3',
                engine: 'static-hermes',
                staticHermesRuntime: 'lean',
                developmentMode: true
            });
        } finally {
            consoleLog.mockRestore();
            if (previous.api === undefined) delete process.env.PUMPKIN_API_DIR;
            else process.env.PUMPKIN_API_DIR = previous.api;
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
    it('prints build errors and exits with status 1', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const exitError = new Error('process exit');
        const processExit = vi.spyOn(process, 'exit').mockImplementation(() => {
            throw exitError;
        });

        try {
            await expect(main(['--unknown'], '/not-a-package')).rejects.toBe(exitError);
            expect(consoleError).toHaveBeenCalledWith(
                'pumpkin-plugins-build: unknown argument "--unknown" (supported: --types-only)'
            );
            expect(processExit).toHaveBeenCalledWith(1);
        } finally {
            processExit.mockRestore();
            consoleError.mockRestore();
        }
    });

    it('rethrows unexpected errors without printing a build error', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-error-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        const realApiDir = process.env.PUMPKIN_API_DIR;
        const unexpectedError = new Error('componentizer failed');
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                version: '1.2.3',
                pumpkinPlugin: { entry: 'src/plugin.ts', output: 'build/plugin.wasm', wasi: [] }
            })
        );
        process.env.PUMPKIN_API_DIR = apiDir;
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
            if (realApiDir === undefined) delete process.env.PUMPKIN_API_DIR;
            else process.env.PUMPKIN_API_DIR = realApiDir;
            fs.rmSync(pluginDir, { recursive: true, force: true });
            fs.rmSync(apiDir, { recursive: true, force: true });
        }
    });
});
