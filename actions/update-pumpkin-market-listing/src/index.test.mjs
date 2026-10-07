import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, it } from 'node:test';

const entrypoint = path.resolve(import.meta.dirname, 'index.mjs');

describe('update-pumpkin-market-listing action', () => {
    it('runs its entrypoint', () => {
        const result = spawnSync(process.execPath, [entrypoint], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), 'Action scaffold is ready. Add the implementation in src/index.mjs.');
    });
});
