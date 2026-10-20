import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const vitestBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const made: string[] = [];

afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('definePluginVitestConfig', () => {
    it.each(['unit', 'integration'])(
        'fails the %s project when it finds no tests',
        (project) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-vitest-config-'));
            made.push(dir);
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'no-tests', version: '1.0.0' }));
            const config = path.join(import.meta.dirname, 'vitest.ts');
            fs.writeFileSync(
                path.join(dir, 'vitest.config.ts'),
                `import { definePluginVitestConfig } from ${JSON.stringify(config)};\nexport default definePluginVitestConfig();\n`,
            );

            const result = spawnSync(process.execPath, [vitestBin, 'run', '--project', project], {
                cwd: dir,
                encoding: 'utf8',
                timeout: 30_000,
            });

            expect(result.error).toBeUndefined();
            expect(result.status, result.stdout + result.stderr).not.toBe(0);
            expect(result.stdout + result.stderr).toMatch(/No test files found/);
        },
        40_000,
    );
});
