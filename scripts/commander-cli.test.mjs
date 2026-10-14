import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { it } from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const cliScripts = [
    'scripts/build.mjs',
    'scripts/changed-areas.mjs',
    'scripts/collect-plugins.mjs',
    'scripts/dev.mjs',
    'scripts/market-plugin-metadata.mjs',
    'scripts/market-plugin-name.mjs',
    'scripts/package-metadata.mjs',
    'scripts/prepare-market-plugin.mjs',
    'scripts/release.mjs',
    'scripts/resolve-plugin-release.mjs',
    'scripts/test-external-consumer.mjs',
    'scripts/upstream-pins.mjs',
    'scripts/verify-plugin.mjs',
    'tools/build/runtime/provenance.mjs',
    'tools/docs/bin/pumpkin-plugins-docs.mjs',
    'tools/pumpkin-api/scripts/gen-types.mjs',
    'tools/static-hermes-runtime/test/oracles/generate-api-enums.mjs',
    'tools/static-hermes-runtime/test/oracles/generate-runtime.mjs',
    'packages/waypoints/scripts/generate-icon-sprites.mjs',
];

it('prints help for each repository CLI', () => {
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
