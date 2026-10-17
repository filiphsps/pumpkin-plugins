import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as buildModule from './build.mjs';
import {
    buildTaskEnvironment,
    hasStaticHermesBuild,
    normalizeTurboArgs,
    prepareHermesInIsolatedEnvironment,
    runStaticHermesPreparation,
} from './build.mjs';

const temporaryRoots = [];
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolvedTurboTask(task, packageName) {
    const output = execFileSync(
        process.execPath,
        [
            path.join(workspaceRoot, 'node_modules/turbo/bin/turbo'),
            'run',
            task,
            `--filter=${packageName}`,
            '--dry=json',
        ],
        {
            cwd: workspaceRoot,
            encoding: 'utf8',
            env: { ...process.env, WASM_TOOLS: '/configured/wasm-tools' },
        },
    );
    const graph = JSON.parse(output);
    const matchingTask = graph.tasks.find(({ taskId }) => taskId === `${packageName}#${task}`);
    assert.ok(matchingTask, `Turbo did not include ${packageName}#${task}`);
    return matchingTask.resolvedTaskDefinition;
}

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
            quickjs: { name: '@pumpkin-plugins/quickjs', pumpkinPlugin: { engine: 'quickjs' } },
        });

        assert.equal(
            hasStaticHermesBuild(
                {
                    tasks: [
                        { package: '@pumpkin-plugins/hermes', task: 'transit' },
                        { package: '@pumpkin-plugins/hermes', task: 'build' },
                    ],
                },
                root,
            ),
            true,
        );
    });

    it('leaves QuickJS-only build graphs unprepared', () => {
        const root = createWorkspace({
            quickjs: { name: '@pumpkin-plugins/quickjs', pumpkinPlugin: { engine: 'quickjs' } },
        });

        assert.equal(
            hasStaticHermesBuild(
                {
                    tasks: [
                        { package: '@pumpkin-plugins/quickjs', task: 'build' },
                        { package: '@pumpkin-plugins/static-hermes-runtime', task: 'prepare-hermes' },
                    ],
                },
                root,
            ),
            false,
        );
    });

    it('detects Static Hermes parse-ts build tasks', () => {
        const root = createWorkspace({ hermes: { name: '@pumpkin-plugins/hermes', pumpkinPlugin: {} } });

        assert.equal(
            hasStaticHermesBuild(
                { tasks: [{ package: '@pumpkin-plugins/hermes', task: 'build:parse-ts' }] },
                root,
                'build:parse-ts',
            ),
            true,
        );
    });
});

describe('parse-ts build commands', () => {
    it('registers the parser command for every plugin and starter template', () => {
        const packagesDirectory = path.join(workspaceRoot, 'packages');
        const packageDirectories = fs
            .readdirSync(packagesDirectory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(packagesDirectory, entry.name, 'package.json'));
        const templateDirectory = path.join(workspaceRoot, 'tools/create-pumpkin-plugin/templates');
        const templateManifests = fs
            .readdirSync(templateDirectory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(templateDirectory, entry.name, 'package.json'));
        const manifests = [...packageDirectories, ...templateManifests]
            .filter((manifestPath) => fs.existsSync(manifestPath))
            .map((manifestPath) => ({
                path: manifestPath,
                manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
            }))
            .filter(({ manifest }) => manifest.pumpkinPlugin !== undefined);

        for (const { path: manifestPath, manifest } of manifests) {
            assert.equal(
                manifest.scripts['build:parse-ts'],
                'pumpkin-plugins-build --parse-ts',
                `${path.relative(workspaceRoot, manifestPath)} must define build:parse-ts`,
            );
        }
    });

    it('registers the root command and matching Turbo task', () => {
        const rootPackage = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
        const turbo = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'turbo.json'), 'utf8'));

        assert.match(rootPackage.scripts['build:parse-ts'], /scripts\/build\.mjs .*--parse-ts/);
        assert.deepEqual(turbo.tasks['build:parse-ts'], turbo.tasks.build);
    });

    it('selects the parser task and removes its selector before calling Turbo', () => {
        assert.deepEqual(buildModule.normalizeBuildRequest?.(['--parse-ts', '--', '--filter=example']), {
            task: 'build:parse-ts',
            args: ['--filter=example'],
            dryRun: false,
        });
        assert.deepEqual(buildModule.normalizeBuildRequest?.(['--', '--filter=example']), {
            task: 'build',
            args: ['--filter=example'],
            dryRun: false,
        });
        assert.deepEqual(buildModule.normalizeBuildRequest?.(['--dry=json', '--filter=example']), {
            task: 'build',
            args: ['--filter=example', '--dry=json'],
            dryRun: true,
        });
        assert.deepEqual(buildModule.normalizeBuildRequest?.(['--dry', '--filter=example']), {
            task: 'build',
            args: ['--filter=example', '--dry'],
            dryRun: true,
        });
    });
});

describe('normalizeTurboArgs', () => {
    it('removes the pnpm script separator before forwarding arguments to Turbo', () => {
        assert.deepEqual(normalizeTurboArgs(['--', '--dry=json', '--filter=example']), [
            '--dry=json',
            '--filter=example',
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
            },
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
                options: { cwd: options.cwd, env: options.env },
            })),
            [
                {
                    command: 'pnpm',
                    args: ['--filter', '@pumpkin-plugins/static-hermes-runtime', 'build'],
                    options: { cwd: '/workspace', env },
                },
                {
                    command: process.execPath,
                    args: ['/workspace/tools/static-hermes-runtime/dist/cli.js', 'hermes', 'prepare'],
                    options: { cwd: '/workspace', env },
                },
            ],
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
                WIT_BINDGEN: '/toolchain/wit-bindgen',
            },
        );

        assert.deepEqual(environment, {
            USER_SETTING: 'kept',
            STATIC_HERMES_SOURCE_DIR: '/custom/source',
            STATIC_HERMES_CACHE_DIR: '/workspace/.cache/hermes',
            PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED: '1',
        });
    });
});

describe('Turbo WASM_TOOLS environment', () => {
    it('passes WASM_TOOLS through to plugin build tasks', () => {
        const task = resolvedTurboTask('build', '@pumpkin-plugins/tab-display');

        assert.ok(task.passThroughEnv.includes('WASM_TOOLS'));
    });

    it('passes WASM_TOOLS through to plugin integration tests', () => {
        const task = resolvedTurboTask('test:integration', '@pumpkin-plugins/tab-display');

        assert.ok(task.passThroughEnv.includes('WASM_TOOLS'));
    });
});
