import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { run } from './cli.ts';
import { BuildError } from './errors.ts';
import { generateTypes } from './types.ts';

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
});
