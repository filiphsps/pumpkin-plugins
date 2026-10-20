import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { registerPublicTool } from './register-public-tool.mjs';

const scopedReleaseTitlePattern = ['chore$', '{scope}: release @pumpkin-plugins/$', '{component} $', '{version}'].join(
    '',
);
const temporaryDirectories = [];
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository(toolDirectory = 'tools/codemod', packageName = '@pumpkin-plugins/codemod') {
    const root = mkdtempSync(join(tmpdir(), 'register-public-tool-'));
    temporaryDirectories.push(root);
    mkdirSync(join(root, toolDirectory), { recursive: true });
    writeFileSync(
        join(root, toolDirectory, 'package.json'),
        JSON.stringify({
            name: packageName,
            version: '0.1.0',
            publishConfig: { access: 'public' },
        }),
    );
    writeFileSync(join(root, 'release-please-config.json'), JSON.stringify({ packages: {} }));
    writeFileSync(join(root, '.release-please-manifest.json'), JSON.stringify({}));
    return root;
}

describe('registerPublicTool', () => {
    it('registers a public tool in both Release Please files', () => {
        const root = repository();

        registerPublicTool(root, 'tools/codemod');

        assert.deepEqual(JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8')).packages, {
            'tools/codemod': {
                component: 'codemod',
                'component-no-space': true,
                'pull-request-title-pattern': scopedReleaseTitlePattern,
                'release-as': '0.1.0',
            },
        });
        assert.deepEqual(JSON.parse(readFileSync(join(root, '.release-please-manifest.json'), 'utf8')), {
            'tools/codemod': '0.0.0',
        });
    });

    it('is idempotent for a tool already registered at its current release baseline', () => {
        const root = repository();
        registerPublicTool(root, 'tools/codemod');
        const configBefore = readFileSync(join(root, 'release-please-config.json'), 'utf8');
        const manifestBefore = readFileSync(join(root, '.release-please-manifest.json'), 'utf8');

        registerPublicTool(root, 'tools/codemod');

        assert.equal(readFileSync(join(root, 'release-please-config.json'), 'utf8'), configBefore);
        assert.equal(readFileSync(join(root, '.release-please-manifest.json'), 'utf8'), manifestBefore);
    });

    it('uses the package manifest as the source of the npm package name', () => {
        const root = repository('tools/codemod', '@example/codemod');

        registerPublicTool(root, 'tools/codemod');

        assert.deepEqual(JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8')).packages, {
            'tools/codemod': { component: 'codemod', 'release-as': '0.1.0' },
        });
    });

    it('registers a new public tool with its manifest-declared name', () => {
        const root = repository('tools/example', '@example/custom-tool');

        registerPublicTool(root, 'tools/example');

        assert.equal(
            JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8')).packages['tools/example']
                .component,
            'example',
        );
    });

    it('preserves the registered unscoped create-pumpkin-plugin package name', () => {
        const root = repository('tools/create-pumpkin-plugin', 'create-pumpkin-plugin');

        registerPublicTool(root, 'tools/create-pumpkin-plugin');

        assert.deepEqual(JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8')).packages, {
            'tools/create-pumpkin-plugin': { component: 'create-pumpkin-plugin', 'release-as': '0.1.0' },
        });
    });

    it('repairs a missing first-release pin on an existing registration', () => {
        const root = repository();
        registerPublicTool(root, 'tools/codemod');
        const configPath = join(root, 'release-please-config.json');
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        config.packages['tools/codemod']['release-as'] = undefined;
        writeFileSync(configPath, JSON.stringify(config));

        const result = registerPublicTool(root, 'tools/codemod');

        assert.deepEqual(result, { configChanged: true, manifestChanged: false });
        assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).packages['tools/codemod'], {
            component: 'codemod',
            'component-no-space': true,
            'pull-request-title-pattern': scopedReleaseTitlePattern,
            'release-as': '0.1.0',
        });
    });

    it('rejects a conflicting first-release pin without changing either file', () => {
        const root = repository();
        registerPublicTool(root, 'tools/codemod');
        const configPath = join(root, 'release-please-config.json');
        const manifestPath = join(root, '.release-please-manifest.json');
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        config.packages['tools/codemod']['release-as'] = '0.2.0';
        writeFileSync(configPath, JSON.stringify(config));
        const configBefore = readFileSync(configPath, 'utf8');
        const manifestBefore = readFileSync(manifestPath, 'utf8');

        assert.throws(() => registerPublicTool(root, 'tools/codemod'), /conflicting release-as.*0\.1\.0/);
        assert.equal(readFileSync(configPath, 'utf8'), configBefore);
        assert.equal(readFileSync(manifestPath, 'utf8'), manifestBefore);
    });

    it('rejects paths outside tools before changing either Release Please file', () => {
        const root = repository();
        const configBefore = readFileSync(join(root, 'release-please-config.json'), 'utf8');
        const manifestBefore = readFileSync(join(root, '.release-please-manifest.json'), 'utf8');

        assert.throws(() => registerPublicTool(root, 'packages/codemod'), /must be under tools\//);
        assert.equal(readFileSync(join(root, 'release-please-config.json'), 'utf8'), configBefore);
        assert.equal(readFileSync(join(root, '.release-please-manifest.json'), 'utf8'), manifestBefore);
    });
});
