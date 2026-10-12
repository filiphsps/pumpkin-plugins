import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { hasStaticHermesBuild, normalizeTurboArgs, prepareHermesInIsolatedEnvironment } from './build.mjs';

const temporaryRoots = [];

after(() => {
    for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

function createWorkspace(plugins) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-build-'));
    temporaryRoots.push(root);
    for (const [directory, manifest] of Object.entries(plugins)) {
        const packageDirectory = path.join(root, 'packages', directory);
        fs.mkdirSync(packageDirectory, { recursive: true });
        fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify(manifest));
    }
    return root;
}

describe('hasStaticHermesBuild', () => {
    it('detects selected Static Hermes build tasks, including the default engine', () => {
        const root = createWorkspace({
            hermes: { name: '@pumpkin-plugins/hermes', pumpkinPlugin: {} },
            quickjs: { name: '@pumpkin-plugins/quickjs', pumpkinPlugin: { engine: 'quickjs' } }
        });

        assert.equal(
            hasStaticHermesBuild(
                {
                    tasks: [
                        { package: '@pumpkin-plugins/hermes', task: 'transit' },
                        { package: '@pumpkin-plugins/hermes', task: 'build' }
                    ]
                },
                root
            ),
            true
        );
    });

    it('leaves QuickJS-only build graphs unprepared', () => {
        const root = createWorkspace({
            quickjs: { name: '@pumpkin-plugins/quickjs', pumpkinPlugin: { engine: 'quickjs' } }
        });

        assert.equal(
            hasStaticHermesBuild(
                {
                    tasks: [
                        { package: '@pumpkin-plugins/quickjs', task: 'build' },
                        { package: '@pumpkin-plugins/static-hermes-runtime', task: 'prepare-hermes' }
                    ]
                },
                root
            ),
            false
        );
    });
});

describe('normalizeTurboArgs', () => {
    it('removes the pnpm script separator before forwarding arguments to Turbo', () => {
        assert.deepEqual(normalizeTurboArgs(['--', '--dry=json', '--filter=example']), [
            '--dry=json',
            '--filter=example'
        ]);
    });

    it('keeps Turbo arguments when pnpm did not add a separator', () => {
        assert.deepEqual(normalizeTurboArgs(['--filter=example']), ['--filter=example']);
    });
});

describe('prepareHermesInIsolatedEnvironment', () => {
    it('keeps toolchain defaults out of the caller environment', async () => {
        const env = { USER_SETTING: 'kept', PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED: '1' };
        let prepareEnvironment;
        const preparedEnvironment = await prepareHermesInIsolatedEnvironment({
            workspaceRoot: '/workspace',
            env,
            setupEnvironment: async () => ({ STATIC_HERMES_CACHE_DIR: '/cache/hermes' }),
            runPrepare: async (environment) => {
                prepareEnvironment = environment;
            }
        });

        assert.deepEqual(env, { USER_SETTING: 'kept', PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED: '1' });
        assert.notEqual(preparedEnvironment, env);
        assert.equal(preparedEnvironment.STATIC_HERMES_CACHE_DIR, '/cache/hermes');
        assert.equal(preparedEnvironment.PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED, undefined);
        assert.equal(prepareEnvironment, preparedEnvironment);
    });
});
