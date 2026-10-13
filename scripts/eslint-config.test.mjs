import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ESLint } from 'eslint';

describe('ESLint source coverage', () => {
    it('does not ignore the build tool source package', async () => {
        const eslint = new ESLint();
        const source = path.resolve(import.meta.dirname, '../tools/build/src/wasi-wit.ts');

        assert.equal(await eslint.isPathIgnored(source), false);
    });
});
