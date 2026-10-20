import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { applyUpstreamPin, discoverUpstreamPins } from './upstream-pins.mjs';

const upstreamGitPinSchemaUrl =
    'https://raw.githubusercontent.com/filiphsps/pumpkin-plugins/master/schemas/upstream-git-pin.schema.json';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'upstream-pins-'));
    const pinFile = 'runtime/hermes-source.lock.json';
    const catalogPath = join(root, 'upstream-pins.json');
    mkdirSync(dirname(join(root, pinFile)), { recursive: true });
    writeFileSync(
        join(root, pinFile),
        `${JSON.stringify(
            {
                $schema: upstreamGitPinSchemaUrl,
                repository: 'https://github.com/example/hermes.git',
                branch: 'static_h',
                commit: 'a'.repeat(40),
            },
            null,
            4,
        )}\n`,
    );
    writeFileSync(
        catalogPath,
        `${JSON.stringify(
            {
                sources: [
                    {
                        id: 'static-hermes',
                        name: 'Static Hermes',
                        pinFile,
                        pinField: 'commit',
                        labels: ['dependencies', 'area: runtime', 'runtime: static-hermes'],
                        validation: ['pnpm', '--filter', '@example/hermes', 'prepare'],
                    },
                ],
            },
            null,
            4,
        )}\n`,
    );
    return { root, pinFile, catalogPath };
}

it('discovers newer upstream commits from each pin file and returns review metadata', async () => {
    const f = fixture();
    try {
        const updates = await discoverUpstreamPins({
            workspaceRoot: f.root,
            catalogPath: f.catalogPath,
            lookupRef: async (repository, branch) => {
                assert.equal(repository, 'https://github.com/example/hermes.git');
                assert.equal(branch, 'static_h');
                return 'b'.repeat(40);
            },
        });

        assert.deepEqual(updates, [
            {
                id: 'static-hermes',
                name: 'Static Hermes',
                pinFile: f.pinFile,
                pinField: 'commit',
                repository: 'https://github.com/example/hermes.git',
                branch: 'static_h',
                current: 'a'.repeat(40),
                latest: 'b'.repeat(40),
                needsUpdate: true,
                compareUrl: `https://github.com/example/hermes/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`,
                labels: ['dependencies', 'area: runtime', 'runtime: static-hermes'],
                validation: ['pnpm', '--filter', '@example/hermes', 'prepare'],
            },
        ]);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

it('updates only the configured pin field and preserves other source metadata', () => {
    const f = fixture();
    try {
        applyUpstreamPin({
            workspaceRoot: f.root,
            catalogPath: f.catalogPath,
            id: 'static-hermes',
            commit: 'c'.repeat(40),
        });

        assert.deepEqual(JSON.parse(readFileSync(join(f.root, f.pinFile), 'utf8')), {
            $schema: upstreamGitPinSchemaUrl,
            repository: 'https://github.com/example/hermes.git',
            branch: 'static_h',
            commit: 'c'.repeat(40),
        });
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

it('marks a pin current when the upstream branch still points to its pinned commit', async () => {
    const f = fixture();
    try {
        const updates = await discoverUpstreamPins({
            workspaceRoot: f.root,
            catalogPath: f.catalogPath,
            lookupRef: async () => 'a'.repeat(40),
        });

        assert.equal(updates[0].needsUpdate, false);
        assert.equal(updates[0].current, updates[0].latest);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

it('keeps upstream pin schemas reusable across repositories and release tag formats', () => {
    const gitPin = JSON.parse(
        readFileSync(new URL('../schemas/upstream-git-pin.schema.json', import.meta.url), 'utf8'),
    );
    const releasePin = JSON.parse(
        readFileSync(new URL('../schemas/upstream-release-pin.schema.json', import.meta.url), 'utf8'),
    );
    const wasiSdkPin = JSON.parse(
        readFileSync(new URL('../schemas/wasi-sdk-release-pin.schema.json', import.meta.url), 'utf8'),
    );
    const toolchainSchema = JSON.parse(
        readFileSync(new URL('../schemas/toolchain-versions.schema.json', import.meta.url), 'utf8'),
    );

    assert.equal(gitPin.properties.repository.format, 'uri');
    assert.equal(gitPin.properties.repository.pattern, undefined);
    const commitPattern = new RegExp(gitPin.properties.commit.pattern);
    assert.equal(commitPattern.test('a'.repeat(40)), true);
    assert.equal(commitPattern.test('b'.repeat(64)), true);
    assert.equal(commitPattern.test('c'.repeat(39)), false);

    assert.equal(releasePin.properties.repository.format, 'uri');
    assert.equal(releasePin.properties.repository.pattern, undefined);
    assert.equal(releasePin.properties.version.pattern, undefined);
    assert.equal(releasePin.properties.version.minLength, 1);
    assert.equal(wasiSdkPin.properties.checksums.required.length, 7);
    assert.equal(wasiSdkPin.$defs.sha256.pattern, '^[0-9a-f]{64}$');

    assert.equal(toolchainSchema.properties.tools.additionalProperties.type, 'string');
    assert.equal(toolchainSchema.properties.tools.propertyNames.pattern, '^[a-z0-9]+(?:-[a-z0-9]+)*$');
});
