import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import {
    buildTaskEnvironment,
    hasStaticHermesBuild,
    normalizeTurboArgs,
    prepareHermesInIsolatedEnvironment,
    runStaticHermesPreparation
} from './build.mjs';

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

describe('runStaticHermesPreparation', () => {
    it('builds the runtime package and invokes Hermes preparation through dist/cli.js', () => {
        const calls = [];
        const env = { STATIC_HERMES_CACHE_DIR: '/cache/hermes' };

        runStaticHermesPreparation('/workspace', env, (command, args, options) => {
            calls.push({ command, args, options });
            return { status: 0 };
        });

        assert.deepEqual(
            calls.map(({ command, args, options }) => ({
                command,
                args,
                options: { cwd: options.cwd, env: options.env }
            })),
            [
                {
                    command: 'pnpm',
                    args: ['--filter', '@pumpkin-plugins/static-hermes-runtime', 'build'],
                    options: { cwd: '/workspace', env }
                },
                {
                    command: process.execPath,
                    args: ['/workspace/tools/static-hermes-runtime/dist/cli.js', 'hermes', 'prepare'],
                    options: { cwd: '/workspace', env }
                }
            ]
        );
    });
});

describe('buildTaskEnvironment', () => {
    it('passes the shared cache path and prepared marker without leaking toolchain defaults', () => {
        const environment = buildTaskEnvironment(
            { USER_SETTING: 'kept', STATIC_HERMES_SOURCE_DIR: '/custom/source' },
            {
                STATIC_HERMES_CACHE_DIR: '/workspace/.cache/hermes',
                STATIC_HERMES_WASI_SDK_PATH: '/toolchain/wasi-sdk',
                WIT_BINDGEN: '/toolchain/wit-bindgen'
            }
        );

        assert.deepEqual(environment, {
            USER_SETTING: 'kept',
            STATIC_HERMES_SOURCE_DIR: '/custom/source',
            STATIC_HERMES_CACHE_DIR: '/workspace/.cache/hermes',
            PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED: '1'
        });
    });
});
