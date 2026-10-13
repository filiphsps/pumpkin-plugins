import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { partitionReleasePaths } from './release-fanout.mjs';
import {
    assertPublicToolPackage,
    assertStarterToolDependencies,
    syncStarterToolDependencies
} from './tool-packages.mjs';

const temporaryDirectories = [];
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('public tool release fanout', () => {
    it('keeps public tool packages out of plugin artifact fanout', () => {
        assert.deepEqual(
            partitionReleasePaths([
                { path: 'packages/waypoints' },
                { path: 'actions/sign-pumpkin-plugin' },
                { path: 'tools/build' },
                { path: 'tools/pumpkin-api' },
                { path: 'tools/static-hermes-runtime' },
                { path: 'tools/create-pumpkin-plugin' }
            ]),
            {
                pluginPaths: ['packages/waypoints'],
                actionPaths: ['actions/sign-pumpkin-plugin'],
                toolPaths: [
                    'tools/build',
                    'tools/pumpkin-api',
                    'tools/static-hermes-runtime',
                    'tools/create-pumpkin-plugin'
                ]
            }
        );
    });
});

describe('public tool package metadata', () => {
    it('rejects private packages and requires public npm access', () => {
        const metadata = {
            name: '@pumpkin-plugins/build',
            version: '0.1.0',
            publishConfig: { access: 'public' }
        };

        assert.doesNotThrow(() => assertPublicToolPackage(metadata, '@pumpkin-plugins/build'));
        assert.throws(
            () => assertPublicToolPackage({ ...metadata, private: true }, '@pumpkin-plugins/build'),
            /must not be private/
        );
        assert.throws(
            () => assertPublicToolPackage({ ...metadata, publishConfig: undefined }, '@pumpkin-plugins/build'),
            /publishConfig.access must be public/
        );
    });
});

describe('starter tool dependency versions', () => {
    it('syncs both templates to the current API and builder release ranges', () => {
        const root = mkdtempSync(join(tmpdir(), 'pumpkin-tool-versions-'));
        temporaryDirectories.push(root);
        for (const [directory, name, version] of [
            ['tools/pumpkin-api', '@pumpkin-plugins/pumpkin-api', '0.2.0'],
            ['tools/build', '@pumpkin-plugins/build', '0.3.4']
        ]) {
            mkdirSync(join(root, directory), { recursive: true });
            writeFileSync(join(root, directory, 'package.json'), JSON.stringify({ name, version }));
        }

        const templateDirectories = ['typescript', 'javascript'];
        for (const language of templateDirectories) {
            const directory = join(root, 'tools/create-pumpkin-plugin/templates', language);
            mkdirSync(directory, { recursive: true });
            writeFileSync(
                join(directory, 'package.json'),
                JSON.stringify({
                    dependencies: {
                        '@pumpkin-plugins/pumpkin-api': '^0.1.0',
                        '@pumpkin-plugins/build': '^0.1.0'
                    }
                })
            );
        }

        assert.equal(syncStarterToolDependencies(root), true);
        for (const language of templateDirectories) {
            const packageJson = JSON.parse(
                readFileSync(join(root, 'tools/create-pumpkin-plugin/templates', language, 'package.json'), 'utf8')
            );
            assertStarterToolDependencies(packageJson, {
                '@pumpkin-plugins/pumpkin-api': '0.2.0',
                '@pumpkin-plugins/build': '0.3.4'
            });
        }
    });

    it('fails if either starter template is stale for the packages that will be packed', () => {
        const packageJson = {
            dependencies: {
                '@pumpkin-plugins/pumpkin-api': '^0.1.0',
                '@pumpkin-plugins/build': '^0.1.0'
            }
        };

        assert.throws(
            () =>
                assertStarterToolDependencies(packageJson, {
                    '@pumpkin-plugins/pumpkin-api': '0.2.0',
                    '@pumpkin-plugins/build': '0.3.4'
                }),
            /must be \^0\.2\.0/
        );
    });
});
