import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { getInput, setOutput } from './utils.mjs';

const hyphenatedKey = 'INPUT_ACTION-TEST-HYPHENATED-NAME';
const underscoreKey = 'INPUT_ACTION_TEST_HYPHENATED_NAME';
const spacedKey = 'INPUT_ACTION_TEST-SPACED-NAME';
const outputPath = path.join(os.tmpdir(), `pumpkin-publish-output-${process.pid}`);
const previousOutput = process.env.GITHUB_OUTPUT;
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
    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previousOutput;
    fs.rmSync(outputPath, { force: true });
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

    it('writes outputs using a delimiter-safe GitHub output file entry', () => {
        process.env.GITHUB_OUTPUT = outputPath;
        setOutput('listing-name', 'A listing\nwith more than one line');

        const output = fs.readFileSync(outputPath, 'utf8');
        const [, delimiter] = output.match(/^listing-name<<([^\n]+)$/m) ?? [];
        assert.ok(delimiter);
        assert.equal(output, `listing-name<<${delimiter}\nA listing\nwith more than one line\n${delimiter}\n`);
    });
});
