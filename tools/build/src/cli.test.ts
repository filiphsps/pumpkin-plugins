import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from './cli.ts';
import { BuildError } from './errors.ts';

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
});
