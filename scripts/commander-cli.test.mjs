import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
// Every tracked script that imports Commander is a CLI and must answer --help.
const cliScripts = execFileSync('git', ['ls-files', '*.mjs'], { cwd: repositoryRoot, encoding: 'utf8' })
    .split('\n')
    .filter(
        (file) =>
            file &&
            !file.endsWith('.test.mjs') &&
            /from 'commander'/.test(fs.readFileSync(path.join(repositoryRoot, file), 'utf8')),
    );

it('prints help for each repository CLI', () => {
    assert.ok(cliScripts.length > 0, 'found no tracked script that imports Commander');
    for (const script of cliScripts) {
        const result = spawnSync(process.execPath, [path.join(repositoryRoot, script), '--help'], {
            cwd: repositoryRoot,
            encoding: 'utf8',
            timeout: 5000,
        });
        const output = `${result.stdout}${result.stderr}`;
        assert.equal(result.status, 0, `${script} --help failed:\n${output}`);
        assert.match(output, /Usage:/, `${script} did not print Commander usage:\n${output}`);
    }
});
