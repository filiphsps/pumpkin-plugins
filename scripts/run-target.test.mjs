import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { it } from 'node:test';

it('refuses to package a nightly target before invoking Turbo', () => {
    const run = spawnSync(
        process.execPath,
        [path.join(import.meta.dirname, 'run-target.mjs'), '--release-only', 'build'],
        {
            env: { ...process.env, PUMPKIN_API_TARGET: 'nightly' },
            encoding: 'utf8'
        }
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Packaging requires the release target/);
});
it('refuses source overrides when packaging the release profile', () => {
    for (const key of ['PUMPKIN_API_DIR', 'PUMPKIN_API_ENTRY', 'PUMPKIN_WIT_DIR']) {
        const run = spawnSync(
            process.execPath,
            [path.join(import.meta.dirname, 'run-target.mjs'), '--release-only', 'build'],
            {
                env: { ...process.env, PUMPKIN_API_TARGET: 'release', [key]: '/custom-source' },
                encoding: 'utf8'
            }
        );
        assert.equal(run.status, 1);
        assert.match(run.stderr, /Packaging does not accept API or WIT overrides/);
    }
});
