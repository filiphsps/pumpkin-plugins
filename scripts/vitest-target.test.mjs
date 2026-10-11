import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';

it('unit tests execute the selected API and pick up edits at the same local source path', () => {
    const harness = path.resolve(import.meta.dirname, '../tools/test-harness');
    fs.mkdirSync(path.join(harness, '.cache'), { recursive: true });
    const fixture = fs.mkdtempSync(path.join(harness, '.cache', 'vitest-profile-'));
    try {
        fs.mkdirSync(path.join(fixture, 'src'));
        fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module","version":"1.0.0"}');
        fs.writeFileSync(
            path.join(fixture, 'vitest.config.ts'),
            `import { definePluginVitestConfig } from ${JSON.stringify(path.join(harness, 'src/vitest.ts'))}; export default definePluginVitestConfig();`
        );
        fs.writeFileSync(
            path.join(fixture, 'src/profile.test.ts'),
            `import { it, expect } from 'vitest'; import { selectedValue } from '@pumpkinmc/pumpkin-api-ts'; it('executes selected API', () => expect(selectedValue()).toBe(Number(process.env.EXPECTED_API_VALUE)));`
        );
        const first = path.join(fixture, 'first.ts');
        const second = path.join(fixture, 'second.ts');
        fs.writeFileSync(first, 'export function selectedValue() { return 42; }');
        fs.writeFileSync(second, 'export function selectedValue() { return 99; }');
        for (const [entry, value] of [
            [first, 42],
            [second, 99],
            [second, 100]
        ]) {
            if (value === 100) fs.writeFileSync(second, 'export function selectedValue() { return 100; }');
            const run = spawnSync(
                process.execPath,
                [path.join(harness, 'node_modules/vitest/vitest.mjs'), 'run', '--project', 'unit'],
                {
                    cwd: fixture,
                    env: { ...process.env, PUMPKIN_API_ENTRY: entry, EXPECTED_API_VALUE: String(value) },
                    encoding: 'utf8'
                }
            );
            assert.equal(run.status, 0, run.stdout + run.stderr);
        }
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});
