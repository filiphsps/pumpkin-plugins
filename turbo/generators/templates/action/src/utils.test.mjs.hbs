import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { getInput } from './utils.mjs';

const hyphenatedKey = 'INPUT_ACTION-TEST-HYPHENATED-NAME';
const underscoreKey = 'INPUT_ACTION_TEST_HYPHENATED_NAME';
const spacedKey = 'INPUT_ACTION_TEST-SPACED-NAME';
const previousValues = new Map([
    [hyphenatedKey, process.env[hyphenatedKey]],
    [underscoreKey, process.env[underscoreKey]],
    [spacedKey, process.env[spacedKey]]
]);

afterEach(() => {
    for (const [key, value] of previousValues) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe('action input utilities', () => {
    it('preserves hyphens in GitHub input environment names', () => {
        process.env[hyphenatedKey] = 'hyphenated value';
        process.env[underscoreKey] = 'wrong underscore value';

        assert.equal(getInput('action-test-hyphenated-name'), 'hyphenated value');
    });

    it('converts spaces to underscores while preserving hyphens', () => {
        process.env[spacedKey] = 'spaced value';

        assert.equal(getInput('action test-spaced-name'), 'spaced value');
    });
});
