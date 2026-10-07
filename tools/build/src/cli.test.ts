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

    it('builds the configured entry and reports the output size', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-build-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        const realApiDir = process.env.PUMPKIN_API_DIR;
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                version: '1.2.3',
                pumpkinPlugin: { entry: 'src/plugin.ts', output: 'build/plugin.wasm', wasi: [] }
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

    it('marks bundles created for pnpm dev as development builds', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-dev-build-'));
        const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-api-'));
        const realApiDir = process.env.PUMPKIN_API_DIR;
        const realDevMode = process.env.PUMPKIN_DEV_MODE;
        fs.writeFileSync(
            path.join(pluginDir, 'package.json'),
            JSON.stringify({
                version: '1.2.3',
                pumpkinPlugin: { entry: 'src/plugin.ts', output: 'build/plugin.wasm', wasi: [] }
            })
        );
        process.env.PUMPKIN_API_DIR = apiDir;
        process.env.PUMPKIN_DEV_MODE = '1';
        vi.mocked(bundlePlugin).mockClear().mockResolvedValue(2048);
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            await run([], pluginDir);

            expect(bundlePlugin).toHaveBeenCalledWith({
                entry: path.join(pluginDir, 'src/plugin.ts'),
                output: path.join(pluginDir, 'build/plugin.wasm'),
                witDir: path.join(apiDir, 'wit', 'v0.1'),
                version: '1.2.3',
                developmentMode: true
            });
        } finally {
            consoleLog.mockRestore();
            if (realApiDir === undefined) delete process.env.PUMPKIN_API_DIR;
            else process.env.PUMPKIN_API_DIR = realApiDir;
            if (realDevMode === undefined) delete process.env.PUMPKIN_DEV_MODE;
            else process.env.PUMPKIN_DEV_MODE = realDevMode;
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
