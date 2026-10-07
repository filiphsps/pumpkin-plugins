import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { getInput, setOutput } from './utils.mjs';

const hyphenatedKey = 'INPUT_ACTION-TEST-HYPHENATED-NAME';
const underscoreKey = 'INPUT_ACTION_TEST_HYPHENATED_NAME';
const spacedKey = 'INPUT_ACTION_TEST-SPACED-NAME';
const previousValues = new Map([
    [hyphenatedKey, process.env[hyphenatedKey]],
    [underscoreKey, process.env[underscoreKey]],
    [spacedKey, process.env[spacedKey]]
]);
const outputDirs = [];
const previousOutput = process.env.GITHUB_OUTPUT;

afterEach(() => {
    for (const [key, value] of previousValues) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previousOutput;
    for (const dir of outputDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('shared action utilities', () => {
    it('preserves hyphens in GitHub input environment names', () => {
        process.env[hyphenatedKey] = 'hyphenated value';
        process.env[underscoreKey] = 'wrong underscore value';

        assert.equal(getInput('action-test-hyphenated-name'), 'hyphenated value');
    });

    it('converts spaces to underscores while preserving hyphens', () => {
        process.env[spacedKey] = 'spaced value';

        assert.equal(getInput('action test-spaced-name'), 'spaced value');
    });

    it('writes outputs with a delimiter-safe GitHub output file entry', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-utils-'));
        outputDirs.push(dir);
        const outputFile = path.join(dir, 'github-output');
        process.env.GITHUB_OUTPUT = outputFile;

        setOutput('action-test-result', 'first line\nsecond line');

        const contents = fs.readFileSync(outputFile, 'utf8');
        const match = /^action-test-result<<([^\n]+)\n([\s\S]*?)\n\1\n$/.exec(contents);
        assert.ok(match, 'output should use the GitHub Actions multiline format');
        assert.equal(match[2], 'first line\nsecond line');
    });
});
