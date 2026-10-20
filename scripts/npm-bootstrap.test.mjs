import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { bootstrapPublicTool, parseBootstrapArguments } from './npm-bootstrap.mjs';
import { discoverPublicToolPackages, nodeEngineRange } from './utils/tool-packages.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temporaryDirectories = [];
const publicTools = discoverPublicToolPackages(root);
const toolsByPath = new Map(publicTools.map((tool) => [tool.path, tool]));
const packageNames = Object.fromEntries(publicTools.map(({ path: packagePath, name }) => [packagePath, name]));
const API = toolsByPath.get('tools/pumpkin-api').name;
const DOCS = toolsByPath.get('tools/docs').name;
const RUNTIME = toolsByPath.get('tools/static-hermes-runtime').name;
const BUILD = toolsByPath.get('tools/build').name;

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function manifest(packagePath, overrides = {}) {
    const source = JSON.parse(fs.readFileSync(path.join(root, packagePath, 'package.json'), 'utf8'));
    const publicNames = new Set(publicTools.map(({ name }) => name));
    const dependencies = Object.fromEntries(
        Object.keys(source.dependencies ?? {})
            .filter((name) => publicNames.has(name))
            .map((name) => [name, '0.1.0']),
    );
    const packageJson = {
        name: packageNames[packagePath],
        version: '0.1.0',
        engines: { node: nodeEngineRange(root) },
        publishConfig: { access: 'public' },
        exports: { '.': './src/index.ts' },
        ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
        ...overrides,
    };
    return packageJson;
}

function contentEntries() {
    return ['package/package.json', 'package/src/index.ts'];
}

function profileJson(mode) {
    return JSON.stringify({ name: 'test-maintainer', tfa: mode ? { pending: false, mode } : false });
}

function makeFixture({
    packagePath = 'tools/pumpkin-api',
    archiveEntries,
    sourceManifest,
    packedManifest,
    packedEntries,
    embeddedPackageJsons = [],
    registry = {},
} = {}) {
    const events = {
        fetch: [],
        extracted: [],
        installed: [],
        packed: [],
        registry: [],
        preflight: [],
        published: [],
        removed: [],
    };
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-bootstrap-test-'));
    temporaryDirectories.push(temp);
    const packedBytes = Buffer.from('verified package tarball');
    const expectedIntegrity = `sha512-${createHash('sha512').update(packedBytes).digest('base64')}`;
    const component = packagePath.slice('tools/'.length);
    const tag = `${component}-v0.1.0`;
    const rootName = `pumpkin-plugins-${tag}`;
    const selectedManifest = sourceManifest ?? manifest(packagePath);

    const adapters = {
        root,
        fetch: async (url) => {
            events.fetch.push(url);
            return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('source archive') };
        },
        createTempDirectory: () => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-bootstrap-run-'));
            temporaryDirectories.push(directory);
            return directory;
        },
        removeTempDirectory: (directory) => {
            events.removed.push(directory);
            fs.rmSync(directory, { recursive: true, force: true });
        },
        archive: {
            listEntries: async () => archiveEntries ?? [`${rootName}/`, `${rootName}/${packagePath}/package.json`],
            extract: async (_archiveFile, destination, extractedRoot) => {
                events.extracted.push(extractedRoot);
                const sourceRoot = path.join(destination, extractedRoot);
                fs.mkdirSync(sourceRoot, { recursive: true });
                fs.copyFileSync(path.join(root, '.node-version'), path.join(sourceRoot, '.node-version'));
                for (const { path: toolPath } of publicTools) {
                    fs.mkdirSync(path.join(sourceRoot, toolPath), { recursive: true });
                    fs.writeFileSync(
                        path.join(sourceRoot, toolPath, 'package.json'),
                        `${JSON.stringify(toolPath === packagePath ? selectedManifest : manifest(toolPath))}\n`,
                    );
                }
                fs.copyFileSync(
                    path.join(root, 'release-please-config.json'),
                    path.join(sourceRoot, 'release-please-config.json'),
                );
                return sourceRoot;
            },
            install: async (sourceRoot) => events.installed.push(sourceRoot),
            pack: async (packageDirectory, destination) => {
                events.packed.push(packageDirectory);
                const tarballPath = path.join(destination, `${path.basename(packageDirectory)}-0.1.0.tgz`);
                fs.writeFileSync(tarballPath, packedBytes);
                return {
                    tarballPath,
                    integrity: expectedIntegrity,
                    entries: packedEntries ?? contentEntries(),
                    packageJson: packedManifest ?? manifest(packagePath),
                    embeddedPackageJsons,
                };
            },
        },
        registry: {
            getPackage: async (name) => {
                events.registry.push(['package', name]);
                return registry.getPackage?.(name) ?? { kind: 'missing' };
            },
            getVersion: async (name, version) => {
                events.registry.push(['version', name, version]);
                return registry.getVersion?.(name, version) ?? { kind: 'not-found' };
            },
        },
        npm: {
            preflight: async (details) => {
                events.preflight.push(details);
                return { username: 'test-maintainer', ownerConfirmed: true, writeAccessConfirmed: true };
            },
            publish: async (tarball, args) => events.published.push({ tarball, args }),
        },
    };
    return { adapters, events, expectedIntegrity, packagePath, tag, packedBytes };
}

function bootstrapFixture(fixture, options = {}, adapters = fixture.adapters, expectedOwner = 'test-maintainer') {
    return bootstrapPublicTool(
        {
            packagePath: fixture.packagePath,
            tag: fixture.tag,
            expectedOwner,
            confirmWriteAccess: true,
            ...options,
        },
        adapters,
    );
}

describe('npm first-release bootstrap', () => {
    it('supports bootstrapping the public docs package at its first release', async () => {
        const fixture = makeFixture({ packagePath: 'tools/docs' });

        const result = await bootstrapFixture(fixture, { dryRun: true });

        assert.equal(result.status, 'dry-run');
        assert.equal(result.packageName, DOCS);
        assert.equal(result.version, '0.1.0');
        assert.deepEqual(fixture.events.registry, [
            ['package', DOCS],
            ['version', DOCS, '0.1.0'],
        ]);
    });

    it('requires explicit owner identity and write-access confirmation before normal work', async () => {
        const fixture = makeFixture();

        await assert.rejects(
            bootstrapPublicTool({ packagePath: fixture.packagePath, tag: fixture.tag }, fixture.adapters),
            /--expected-owner <npm-username> is required for normal publishing/,
        );
        assert.deepEqual(fixture.events.fetch, []);
        assert.throws(
            () => parseBootstrapArguments(['tools/pumpkin-api', '--tag', fixture.tag]),
            /--expected-owner <npm-username> is required for normal publishing/,
        );
        assert.deepEqual(parseBootstrapArguments(['tools/pumpkin-api', '--tag', fixture.tag, '--dry-run']), {
            packagePath: 'tools/pumpkin-api',
            tag: fixture.tag,
            dryRun: true,
            expectedOwner: undefined,
            confirmWriteAccess: false,
        });
        assert.deepEqual(
            parseBootstrapArguments([
                'tools/pumpkin-api',
                '--tag',
                fixture.tag,
                '--expected-owner',
                'maintainer',
                '--confirm-write-access',
            ]),
            {
                packagePath: 'tools/pumpkin-api',
                tag: fixture.tag,
                dryRun: false,
                expectedOwner: 'maintainer',
                confirmWriteAccess: true,
            },
        );
        await assert.rejects(
            bootstrapPublicTool(
                { packagePath: fixture.packagePath, tag: fixture.tag, expectedOwner: 'maintainer' },
                fixture.adapters,
            ),
            /--confirm-write-access is required for normal publishing/,
        );
        assert.deepEqual(fixture.events.fetch, []);

        const mismatchedIdentity = makeFixture();
        await assert.rejects(
            bootstrapFixture(mismatchedIdentity, {}, mismatchedIdentity.adapters, 'different-owner'),
            /authenticated npm account does not match expected owner different-owner/,
        );
        assert.deepEqual(mismatchedIdentity.events.published, []);
    });

    it('rejects an unknown workspace path before downloading an archive', async () => {
        const fixture = makeFixture();

        await assert.rejects(
            bootstrapPublicTool(
                { packagePath: 'tools/private-helper', tag: 'private-helper-v0.1.0' },
                fixture.adapters,
            ),
            /unknown public tool release path/,
        );
        assert.deepEqual(fixture.events.fetch, []);
    });

    it('requires the Release Please component tag and exact first version', async () => {
        for (const tag of ['build-v0.1.0', 'pumpkin-api-v0.2.0', 'pumpkin-api-0.1.0']) {
            const fixture = makeFixture();
            await assert.rejects(
                bootstrapPublicTool({ packagePath: 'tools/pumpkin-api', tag }, fixture.adapters),
                /tag must be pumpkin-api-v0\.1\.0/,
            );
            assert.deepEqual(fixture.events.fetch, []);
        }
    });

    it('downloads the exact tag, installs the tagged workspace, and packs only the selected package', async () => {
        const fixture = makeFixture();

        const result = await bootstrapFixture(fixture);

        assert.equal(
            fixture.events.fetch[0],
            'https://codeload.github.com/filiphsps/pumpkin-plugins/tar.gz/refs/tags/pumpkin-api-v0.1.0',
        );
        assert.equal(fixture.events.installed.length, 1);
        assert.deepEqual(
            fixture.events.packed.map((directory) => path.basename(directory)),
            ['pumpkin-api'],
        );
        assert.deepEqual(fixture.events.published[0].args, ['--access', 'public']);
        assert.equal(result.status, 'published');
        assert.equal(fixture.events.preflight[0].expectedOwner, 'test-maintainer');
        assert.equal(fixture.events.preflight[0].confirmWriteAccess, true);
        assert.equal(fixture.events.removed.length, 1);
    });

    it('downloads the tagged source from the repository named in the root package.json', async () => {
        const fixture = makeFixture({ packagePath: 'tools/docs' });
        const forkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-bootstrap-fork-'));
        temporaryDirectories.push(forkRoot);
        fs.writeFileSync(
            path.join(forkRoot, 'package.json'),
            JSON.stringify({ repository: { url: 'git+https://github.com/example-owner/example-fork.git' } }),
        );
        for (const file of ['.node-version', 'release-please-config.json']) {
            fs.copyFileSync(path.join(root, file), path.join(forkRoot, file));
        }
        fs.mkdirSync(path.join(forkRoot, 'tools/docs'), { recursive: true });
        fs.writeFileSync(path.join(forkRoot, 'tools/docs/package.json'), JSON.stringify(manifest('tools/docs')));
        fixture.adapters.root = forkRoot;

        await bootstrapFixture(fixture, { dryRun: true });

        assert.equal(
            fixture.events.fetch[0],
            'https://codeload.github.com/example-owner/example-fork/tar.gz/refs/tags/docs-v0.1.0',
        );
    });

    it('rejects archive traversal entries before extracting them', async () => {
        const unsafeArchives = [
            ['pumpkin-plugins-pumpkin-api-v0.1.0/', 'pumpkin-plugins-pumpkin-api-v0.1.0/../../outside'],
            ['/outside'],
        ];
        for (const archiveEntries of unsafeArchives) {
            const fixture = makeFixture({ archiveEntries });

            await assert.rejects(bootstrapFixture(fixture), /unsafe archive path/);
            assert.deepEqual(fixture.events.extracted, []);
            assert.deepEqual(fixture.events.installed, []);
            assert.equal(fixture.events.removed.length, 1);
        }
    });

    it('requires a successful source archive response', async () => {
        const fixture = makeFixture();
        fixture.adapters.fetch = async () => ({ ok: false, status: 503 });

        await assert.rejects(
            bootstrapFixture(fixture),
            /source archive request for pumpkin-api-v0\.1\.0 failed with HTTP 503/,
        );
        assert.deepEqual(fixture.events.extracted, []);
        assert.equal(fixture.events.removed.length, 1);
    });

    it('rejects packed metadata or required-content mismatches', async () => {
        const wrongName = makeFixture({
            packedManifest: manifest('tools/pumpkin-api', { name: '@pumpkin-plugins/wrong-name' }),
        });
        await assert.rejects(bootstrapFixture(wrongName), /packed metadata does not match its tagged source manifest/);

        const missingFile = makeFixture({ packedEntries: ['package/package.json'] });
        await assert.rejects(bootstrapFixture(missingFile), /packed package is missing package\/src\/index\.ts/);
    });

    it('requires exact public prerequisites before bootstrapping the builder', async () => {
        const fixture = makeFixture({ packagePath: 'tools/build' });
        fixture.adapters.registry.getVersion = async (name, version) => {
            fixture.events.registry.push(['version', name, version]);
            return name === API ? { kind: 'not-found' } : { kind: 'found', integrity: 'sha512-runtime' };
        };

        await assert.rejects(
            bootstrapFixture(fixture),
            /@pumpkin-plugins\/pumpkin-api@0\.1\.0 is not available on npm/,
        );
        assert.deepEqual(fixture.events.preflight, []);
        assert.deepEqual(fixture.events.published, []);
    });

    it('checks the packed builder against API and runtime versions from the tagged archive', async () => {
        const fixture = makeFixture({
            packagePath: 'tools/build',
            packedManifest: manifest('tools/build', {
                dependencies: { [API]: '0.2.0', [RUNTIME]: '0.1.0' },
            }),
        });

        await assert.rejects(
            bootstrapFixture(fixture),
            /@pumpkin-plugins\/pumpkin-api build dependency must resolve to packed version 0\.1\.0/,
        );
        assert.deepEqual(fixture.events.registry, []);
        assert.deepEqual(fixture.events.published, []);
    });

    it('checks both creator templates against their exact public API and build versions', async () => {
        const fixture = makeFixture({
            packagePath: 'tools/create-pumpkin-plugin',
            embeddedPackageJsons: [
                { dependencies: { [API]: '^0.2.0', [BUILD]: '^0.2.0' } },
                { dependencies: { [API]: '^0.2.0', [BUILD]: '^0.2.0' } },
            ],
        });

        await assert.rejects(
            bootstrapFixture(fixture),
            /@pumpkin-plugins\/pumpkin-api template dependency must be \^0\.1\.0/,
        );
        assert.deepEqual(fixture.events.registry, []);
        assert.deepEqual(fixture.events.published, []);
    });

    it('dry-run validates against the registry without publishing', async () => {
        const fixture = makeFixture();

        const result = await bootstrapFixture(fixture, { dryRun: true });

        assert.equal(result.status, 'dry-run');
        assert.ok(fixture.events.registry.some(([kind]) => kind === 'package'));
        assert.deepEqual(fixture.events.preflight, []);
        assert.deepEqual(fixture.events.published, []);
    });

    it('treats only an npm E404 response as a definitive missing package version', async () => {
        const missing = makeFixture();
        missing.adapters.registry = undefined;
        missing.adapters.runCommand = () => ({ status: 1, stdout: '', stderr: 'npm ERR! code E404\n' });

        const result = await bootstrapFixture(missing, { dryRun: true });

        assert.equal(result.status, 'dry-run');
        assert.deepEqual(missing.events.published, []);

        const unauthorized = makeFixture();
        unauthorized.adapters.registry = undefined;
        unauthorized.adapters.runCommand = () => ({ status: 1, stdout: '', stderr: 'npm ERR! code E401\n' });
        await assert.rejects(
            bootstrapFixture(unauthorized, { dryRun: true }),
            /registry check failed: .*failed \(E401\)/,
        );
        assert.deepEqual(unauthorized.events.published, []);
    });

    it('publishes only after the authenticated npm preflight succeeds', async () => {
        const fixture = makeFixture();

        const result = await bootstrapFixture(fixture);

        assert.equal(fixture.events.preflight.length, 1);
        assert.equal(fixture.events.preflight[0].packageName, API);
        assert.equal(fixture.events.preflight[0].packageExists, false);
        assert.equal(fixture.events.published.length, 1);
        assert.equal(result.status, 'published');
    });

    it('runs npm CLI commands outside the workspace so devEngines cannot block them', async () => {
        const fixture = makeFixture();
        fixture.adapters.npm = undefined;
        const commands = [];
        fixture.adapters.runCommand = (command, args, options) => {
            assert.equal(command, 'npm');
            assert.equal(options?.cwd, os.tmpdir());
            commands.push(args[0]);
            if (args[0] === 'whoami') return { status: 0, stdout: 'test-maintainer\n', stderr: '' };
            if (args[0] === 'profile') return { status: 0, stdout: profileJson('auth-only'), stderr: '' };
            if (args[0] === 'org') return { status: 0, stdout: '{"test-maintainer":"developer"}', stderr: '' };
            if (args[0] === 'publish') return { status: 0, stdout: '', stderr: '' };
            return { status: 1, stdout: '', stderr: 'unexpected npm command' };
        };

        const result = await bootstrapFixture(fixture);

        assert.equal(result.status, 'published');
        assert.deepEqual(commands, ['whoami', 'profile', 'org', 'publish']);
    });

    it('rejects an existing package owner mismatch even when the account is a write collaborator', async () => {
        const fixture = makeFixture({ registry: { getPackage: () => ({ kind: 'found', name: API }) } });
        fixture.adapters.npm = undefined;
        const commands = [];
        fixture.adapters.runCommand = (command, args) => {
            commands.push([command, args]);
            if (args[0] === 'whoami') return { status: 0, stdout: 'expected-owner\n', stderr: '' };
            if (args[0] === 'profile') return { status: 0, stdout: profileJson('auth-only'), stderr: '' };
            if (args[0] === 'owner') {
                return { status: 0, stdout: 'unexpected-owner <owner@example.invalid>\n', stderr: '' };
            }
            if (args[0] === 'access') return { status: 0, stdout: '{"expected-owner":"write"}', stderr: '' };
            return { status: 0, stdout: '', stderr: '' };
        };

        await assert.rejects(
            bootstrapPublicTool(
                {
                    packagePath: fixture.packagePath,
                    tag: fixture.tag,
                    expectedOwner: 'expected-owner',
                    confirmWriteAccess: true,
                },
                fixture.adapters,
            ),
            /expected package owner expected-owner was not present in npm owner ls/,
        );
        assert.equal(
            commands.some(([command, args]) => command === 'npm' && args[0] === 'publish'),
            false,
        );
        assert.deepEqual(fixture.events.published, []);
    });

    it('accepts both account-level 2FA modes and queries npm orgs without the scope marker', async () => {
        for (const twoFactorMode of ['auth-only', 'auth-and-writes']) {
            const fixture = makeFixture();
            fixture.adapters.npm = undefined;
            const commands = [];
            fixture.adapters.runCommand = (command, args) => {
                commands.push([command, args]);
                if (args[0] === 'whoami') return { status: 0, stdout: 'test-maintainer\n', stderr: '' };
                if (args[0] === 'profile') {
                    return { status: 0, stdout: profileJson(twoFactorMode), stderr: '' };
                }
                if (args[0] === 'org') {
                    return { status: 0, stdout: '{"test-maintainer":"developer"}', stderr: '' };
                }
                return { status: 0, stdout: '', stderr: '' };
            };

            const result = await bootstrapFixture(fixture, {}, fixture.adapters, 'test-maintainer');

            assert.equal(result.status, 'published');
            assert.ok(
                commands.some(
                    ([command, args]) => command === 'npm' && args[0] === 'org' && args[2] === 'pumpkin-plugins',
                ),
            );
            assert.ok(fixture.events.removed.length > 0);
        }
    });

    it('requires an explicit owner/write confirmation for an unclaimed unscoped package', async () => {
        const fixture = makeFixture({
            packagePath: 'tools/create-pumpkin-plugin',
            embeddedPackageJsons: [
                { dependencies: { [API]: '^0.1.0', [BUILD]: '^0.1.0' } },
                { dependencies: { [API]: '^0.1.0', [BUILD]: '^0.1.0' } },
            ],
        });
        fixture.adapters.registry.getVersion = async (name, version) => {
            fixture.events.registry.push(['version', name, version]);
            return name === 'create-pumpkin-plugin'
                ? { kind: 'not-found' }
                : { kind: 'found', integrity: 'sha512-dependency' };
        };
        fixture.adapters.npm = undefined;
        const commands = [];
        const authorizationNotes = [];
        fixture.adapters.onAuthorizationNote = (note) => authorizationNotes.push(note);
        fixture.adapters.runCommand = (command, args) => {
            commands.push([command, args]);
            if (args[0] === 'whoami') return { status: 0, stdout: 'maintainer-account\n', stderr: '' };
            if (args[0] === 'profile') return { status: 0, stdout: profileJson('auth-only'), stderr: '' };
            if (args[0] === 'publish') {
                assert.equal(authorizationNotes.length, 1, 'authorization confirmation must be visible before publish');
            }
            return { status: 0, stdout: '', stderr: '' };
        };

        const result = await bootstrapFixture(fixture, {}, fixture.adapters, 'maintainer-account');

        assert.equal(result.status, 'published');
        assert.match(authorizationNotes[0], /maintainer-account as the intended owner and confirms write access/);
        assert.equal(
            commands.some(([command, args]) => command === 'npm' && args[0] === 'org'),
            false,
        );
        assert.equal(
            commands.some(([command, args]) => command === 'npm' && args[0] === 'publish'),
            true,
        );
    });

    it('fails closed when the scoped account is not present in npm org output', async () => {
        const fixture = makeFixture();
        fixture.adapters.npm = undefined;
        const commands = [];
        fixture.adapters.runCommand = (command, args) => {
            commands.push([command, args]);
            if (args[0] === 'whoami') return { status: 0, stdout: 'test-maintainer\n', stderr: '' };
            if (args[0] === 'profile') return { status: 0, stdout: profileJson('auth-only'), stderr: '' };
            if (args[0] === 'org') return { status: 0, stdout: '{"somebody-else":"owner"}', stderr: '' };
            return { status: 0, stdout: '', stderr: '' };
        };

        await assert.rejects(
            bootstrapFixture(fixture),
            /could not confirm test-maintainer belongs to npm organization @pumpkin-plugins/,
        );
        assert.equal(
            commands.some(([command, args]) => command === 'npm' && args[0] === 'publish'),
            false,
        );
    });

    it('does not publish when the npm account has no account-level 2FA', async () => {
        const fixture = makeFixture();
        fixture.adapters.npm = undefined;
        const commands = [];
        fixture.adapters.runCommand = (_command, args) => {
            commands.push(args[0]);
            if (args[0] === 'whoami') return { status: 0, stdout: 'test-maintainer\n', stderr: '' };
            if (args[0] === 'profile') return { status: 0, stdout: profileJson(undefined), stderr: '' };
            return { status: 0, stdout: '', stderr: '' };
        };

        await assert.rejects(bootstrapFixture(fixture), /npm account must have account-level 2FA enabled/);
        assert.equal(commands.includes('publish'), false);
    });

    it('does not publish when the authenticated npm preflight fails', async () => {
        const fixture = makeFixture();
        fixture.adapters.npm.preflight = async () => {
            fixture.events.preflight.push({ failed: true });
            throw new Error('account-level 2FA is not enabled');
        };

        await assert.rejects(
            bootstrapFixture(fixture),
            /npm authorization preflight failed: account-level 2FA is not enabled/,
        );
        assert.deepEqual(fixture.events.published, []);
    });

    it('does not publish when the preflight leaves ownership or write access unconfirmed', async () => {
        const fixture = makeFixture();
        fixture.adapters.npm.preflight = async () => ({
            username: 'test-maintainer',
            ownerConfirmed: true,
            writeAccessConfirmed: false,
        });

        await assert.rejects(bootstrapFixture(fixture), /package ownership or write access was not confirmed/);
        assert.deepEqual(fixture.events.published, []);
    });

    it('treats an existing version with the same SRI as already bootstrapped', async () => {
        const fixture = makeFixture({
            registry: {
                getPackage: () => ({ kind: 'found', name: API }),
                getVersion: () => ({ kind: 'found', integrity: fixtureIntegrity() }),
            },
        });
        fixture.adapters.npm = undefined;
        const commands = [];
        fixture.adapters.runCommand = (command, args) => {
            commands.push([command, args]);
            if (args[0] === 'whoami') return { status: 0, stdout: 'test-maintainer\n', stderr: '' };
            if (args[0] === 'profile') return { status: 0, stdout: profileJson('auth-and-writes'), stderr: '' };
            if (args[0] === 'owner') {
                return {
                    status: 0,
                    stdout: 'test-maintainer <owner@example.invalid>\nanother-maintainer <other@example.invalid>\n',
                    stderr: '',
                };
            }
            return { status: 0, stdout: '', stderr: '' };
        };

        const result = await bootstrapFixture(fixture);

        assert.equal(result.status, 'already-bootstrapped');
        assert.ok(commands.some(([command, args]) => command === 'npm' && args[0] === 'owner'));
        assert.equal(
            commands.some(([command, args]) => command === 'npm' && args[0] === 'publish'),
            false,
        );
        assert.equal(fixture.events.published.length, 0);

        function fixtureIntegrity() {
            return `sha512-${createHash('sha512').update(Buffer.from('verified package tarball')).digest('base64')}`;
        }
    });

    it('checks package ownership before accepting a matching-SRI rerun', async () => {
        const fixture = makeFixture({
            registry: {
                getPackage: () => ({ kind: 'found', name: API }),
                getVersion: () => ({ kind: 'found', integrity: fixtureIntegrity() }),
            },
        });
        fixture.adapters.npm.preflight = async (details) => {
            fixture.events.preflight.push(details);
            throw new Error('could not confirm the expected package owner');
        };

        await assert.rejects(
            bootstrapPublicTool(
                {
                    packagePath: fixture.packagePath,
                    tag: fixture.tag,
                    expectedOwner: 'expected-owner',
                    confirmWriteAccess: true,
                },
                fixture.adapters,
            ),
            /npm authorization preflight failed: could not confirm the expected package owner/,
        );
        assert.equal(fixture.events.preflight.length, 1);
        assert.deepEqual(fixture.events.published, []);

        function fixtureIntegrity() {
            return `sha512-${createHash('sha512').update(Buffer.from('verified package tarball')).digest('base64')}`;
        }
    });

    it('stops when an existing version has different bytes', async () => {
        const fixture = makeFixture({
            registry: {
                getPackage: () => ({ kind: 'found', name: API }),
                getVersion: () => ({ kind: 'found', integrity: 'sha512-different' }),
            },
        });

        await assert.rejects(bootstrapFixture(fixture), /registry integrity differs from the locally packed tarball/);
        assert.deepEqual(fixture.events.published, []);
    });

    it('fails closed on non-404 registry failures', async () => {
        const fixture = makeFixture({
            registry: {
                getPackage: () => ({ kind: 'error', cause: 'authorization failed' }),
            },
        });

        await assert.rejects(bootstrapFixture(fixture), /registry check failed: authorization failed/);
        assert.deepEqual(fixture.events.published, []);
    });
});
