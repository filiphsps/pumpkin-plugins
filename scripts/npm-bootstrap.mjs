import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    assertPublicToolPackage,
    assertPublicToolPackageContents,
    discoverPublicToolPackages,
    getPublicToolReleasePrerequisites,
    orderPublicToolReleasePaths,
    packAndInspect,
    parseTarEntries,
    publicToolPackageVersions,
} from './utils/tool-packages.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');
const REGISTRY_URL = 'https://registry.npmjs.org/';
const FIRST_RELEASE_VERSION = '0.1.0';
/**
 * Parses the one-package bootstrap command's positional path, release tag, and dry-run option.
 *
 * @param {string[]} args - Arguments passed after the script name.
 * @returns {{ packagePath: string; tag: string; dryRun: boolean; expectedOwner?: string; confirmWriteAccess: boolean }} Parsed bootstrap options.
 * @throws {Error} When an option is missing, repeated, or unsupported.
 */
export function parseBootstrapArguments(args) {
    const remaining = [...args];
    if (remaining[0] === '--') remaining.shift();
    const packagePath = remaining.shift();
    if (!packagePath)
        throw new Error(
            'usage: pnpm npm:bootstrap -- <package-path> --tag <component-v0.1.0> [--dry-run] [--expected-owner <npm-username> --confirm-write-access]',
        );

    let tag;
    let dryRun = false;
    let expectedOwner;
    let confirmWriteAccess = false;
    while (remaining.length > 0) {
        const argument = remaining.shift();
        if (argument === '--tag') {
            if (tag !== undefined) throw new Error('--tag may be supplied only once');
            tag = remaining.shift();
            if (!tag || tag.startsWith('--')) throw new Error('--tag requires a Release Please tag');
        } else if (argument === '--dry-run') {
            if (dryRun) throw new Error('--dry-run may be supplied only once');
            dryRun = true;
        } else if (argument === '--expected-owner') {
            if (expectedOwner !== undefined) throw new Error('--expected-owner may be supplied only once');
            expectedOwner = remaining.shift()?.trim();
            if (!expectedOwner || expectedOwner.startsWith('--')) {
                throw new Error('--expected-owner requires an npm username');
            }
        } else if (argument === '--confirm-write-access') {
            if (confirmWriteAccess) throw new Error('--confirm-write-access may be supplied only once');
            confirmWriteAccess = true;
        } else {
            throw new Error(`unknown bootstrap option: ${argument}`);
        }
    }

    if (!tag) throw new Error('missing required --tag <component-v0.1.0> option');
    if (!dryRun && !expectedOwner) {
        throw new Error('--expected-owner <npm-username> is required for normal publishing');
    }
    if (!dryRun && !confirmWriteAccess) {
        throw new Error('--confirm-write-access is required for normal publishing');
    }
    return { packagePath, tag, dryRun, expectedOwner, confirmWriteAccess };
}

/**
 * Bootstraps one registered public tool from its exact first-release source tag.
 *
 * @param {{ packagePath: string; tag: string; dryRun?: boolean; expectedOwner?: string; confirmWriteAccess?: boolean }} options - Package path, exact release tag, and publish confirmation details.
 * @param {object} [injected] - Optional filesystem, archive, registry, and npm adapters for controlled execution.
 * @returns {Promise<{ status: string; packageName: string; version: string; integrity: string; authorizationNote?: string }>} Bootstrap outcome.
 * @throws {Error} When source, packed package, prerequisites, registry state, or npm authorization is invalid.
 */
export async function bootstrapPublicTool(options, injected = {}) {
    const root = injected.root ?? REPOSITORY_ROOT;
    const { packagePath, tag, dryRun = false } = options;
    const [selectedPath] = orderPublicToolReleasePaths([packagePath], root);
    const tool = discoverPublicToolPackages(root).find(({ path: candidate }) => candidate === selectedPath);
    const packageName = tool.name;
    const releaseConfig = readJson(path.join(root, 'release-please-config.json'), 'release-please-config.json');
    const component = releaseConfig.packages?.[selectedPath]?.component;
    if (typeof component !== 'string' || !component) {
        throw new Error(`${selectedPath} has no Release Please component in release-please-config.json`);
    }
    const expectedTag = `${component}-v${FIRST_RELEASE_VERSION}`;
    if (tag !== expectedTag) throw new Error(`tag must be ${expectedTag}; received ${String(tag)}`);
    const expectedOwner = typeof options.expectedOwner === 'string' ? options.expectedOwner.trim() : '';
    if (!dryRun && !expectedOwner) {
        throw new Error('--expected-owner <npm-username> is required for normal publishing');
    }
    if (!dryRun && options.confirmWriteAccess !== true) {
        throw new Error('--confirm-write-access is required for normal publishing');
    }

    const fetchArchive = injected.fetch ?? globalThis.fetch;
    const archive = injected.archive ?? createArchiveAdapter(injected.runCommand ?? runCommand);
    const registry = injected.registry ?? createRegistryAdapter(injected.runCommand ?? runCommand);
    const npm = injected.npm ?? createNpmAdapter(injected.runCommand ?? runCommand);
    const createTempDirectory =
        injected.createTempDirectory ?? (() => fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-npm-bootstrap-')));
    const removeTempDirectory =
        injected.removeTempDirectory ?? ((directory) => fs.rmSync(directory, { recursive: true, force: true }));
    const onAuthorizationNote = injected.onAuthorizationNote ?? (() => {});

    const temporaryDirectory = createTempDirectory();
    try {
        const archiveFile = path.join(temporaryDirectory, 'source.tar.gz');
        const sourceUrl = `https://codeload.github.com/${githubRepository(root)}/tar.gz/refs/tags/${encodeURIComponent(tag)}`;
        await downloadSourceArchive(fetchArchive, sourceUrl, archiveFile, tag);

        const archiveEntries = await archive.listEntries(archiveFile);
        const archiveRoot = getSafeArchiveRoot(archiveEntries);
        const sourceRoot = await archive.extract(archiveFile, temporaryDirectory, archiveRoot);
        assertPathWithin(sourceRoot, temporaryDirectory, 'extracted source root');

        const taggedConfig = readJson(
            path.join(sourceRoot, 'release-please-config.json'),
            'tagged release-please-config.json',
        );
        if (taggedConfig.packages?.[selectedPath]?.component !== component) {
            throw new Error(`${tag} does not register ${selectedPath} as component ${component}`);
        }

        const packageDirectory = path.join(sourceRoot, selectedPath);
        assertPathWithin(packageDirectory, sourceRoot, 'selected package directory');
        const sourceManifest = readJson(path.join(packageDirectory, 'package.json'), `${selectedPath}/package.json`);
        if (sourceManifest.name !== packageName || sourceManifest.version !== FIRST_RELEASE_VERSION) {
            throw new Error(
                `${selectedPath} source package must be ${packageName}@${FIRST_RELEASE_VERSION}; received ${String(
                    sourceManifest.name,
                )}@${String(sourceManifest.version)}`,
            );
        }
        const taggedPrerequisiteVersions = publicToolPackageVersions(sourceRoot);

        await archive.install(sourceRoot);
        const packDirectory = path.join(temporaryDirectory, 'packed');
        fs.mkdirSync(packDirectory, { recursive: true });
        const packed = await archive.pack(packageDirectory, packDirectory);
        const { tarballPath: tarball, integrity } = packed;
        assertPathWithin(tarball, temporaryDirectory, 'packed tarball');

        if (
            packed.packageJson?.name !== sourceManifest.name ||
            packed.packageJson?.version !== sourceManifest.version
        ) {
            throw new Error(
                `${packageName} packed metadata does not match its tagged source manifest: expected ${packageName}@${FIRST_RELEASE_VERSION}`,
            );
        }
        assertPublicToolPackage(packed.packageJson, packageName, sourceRoot);
        if (packed.packageJson.version !== FIRST_RELEASE_VERSION) {
            throw new Error(`${packageName} packed version must be ${FIRST_RELEASE_VERSION}`);
        }
        assertPublicToolPackageContents(packed.entries, selectedPath, packed.packageJson);

        const prerequisites = getPublicToolReleasePrerequisites(
            selectedPath,
            packed.packageJson,
            taggedPrerequisiteVersions,
            packed.embeddedPackageJsons,
            sourceRoot,
        );
        for (const prerequisite of prerequisites) {
            const result = await readRegistryVersion(registry, prerequisite.packageName, prerequisite.version);
            if (result.kind !== 'found') {
                throw new Error(
                    `${prerequisite.packageName}@${prerequisite.version} is not available on npm; required by ${packageName}@${FIRST_RELEASE_VERSION}`,
                );
            }
            assertRegistryIntegrity(result.integrity, `${prerequisite.packageName}@${prerequisite.version}`);
        }

        const packageResult = await readRegistryPackage(registry, packageName, FIRST_RELEASE_VERSION);
        const versionResult = await readRegistryVersion(registry, packageName, FIRST_RELEASE_VERSION);
        if (packageResult.kind === 'missing' && versionResult.kind === 'found') {
            throw new Error(
                `${packageName}@${FIRST_RELEASE_VERSION} registry response is inconsistent about package ownership`,
            );
        }
        if (packageResult.kind === 'found' && packageResult.name !== packageName) {
            throw new Error(`${packageName}@${FIRST_RELEASE_VERSION} registry metadata identifies a different package`);
        }
        if (versionResult.kind === 'found') {
            assertRegistryIntegrity(versionResult.integrity, `${packageName}@${FIRST_RELEASE_VERSION}`);
            if (versionResult.integrity !== integrity) {
                throw new Error(
                    `${packageName}@${FIRST_RELEASE_VERSION} registry integrity differs from the locally packed tarball`,
                );
            }
        }

        if (versionResult.kind === 'found' && dryRun) {
            return { status: 'already-bootstrapped', packageName, version: FIRST_RELEASE_VERSION, integrity };
        }

        let authorizationNote;
        if (!dryRun) {
            let preflight;
            try {
                preflight = await npm.preflight({
                    packageName,
                    packageExists: packageResult.kind === 'found',
                    expectedOwner,
                    confirmWriteAccess: options.confirmWriteAccess === true,
                });
            } catch (error) {
                throw new Error(
                    `${packageName}@${FIRST_RELEASE_VERSION} npm authorization preflight failed: ${safeCause(error)}`,
                );
            }
            if (!preflight || typeof preflight.username !== 'string' || preflight.username.length === 0) {
                throw new Error(
                    `${packageName}@${FIRST_RELEASE_VERSION} npm authorization preflight did not confirm an authenticated account`,
                );
            }
            if (preflight.username !== expectedOwner) {
                throw new Error(
                    `${packageName}@${FIRST_RELEASE_VERSION} authenticated npm account does not match expected owner ${expectedOwner}`,
                );
            }
            if (preflight.ownerConfirmed !== true || preflight.writeAccessConfirmed !== true) {
                throw new Error(
                    `${packageName}@${FIRST_RELEASE_VERSION} package ownership or write access was not confirmed`,
                );
            }
            authorizationNote = preflight.authorizationNote;
            if (authorizationNote) onAuthorizationNote(authorizationNote);
        }

        if (versionResult.kind === 'found') {
            return { status: 'already-bootstrapped', packageName, version: FIRST_RELEASE_VERSION, integrity };
        }
        if (versionResult.kind !== 'not-found') {
            throw new Error(`${packageName}@${FIRST_RELEASE_VERSION} registry check returned an invalid result`);
        }
        if (dryRun) return { status: 'dry-run', packageName, version: FIRST_RELEASE_VERSION, integrity };

        try {
            await npm.publish(tarball, ['--access', 'public']);
        } catch (error) {
            throw new Error(`${packageName}@${FIRST_RELEASE_VERSION} publish failed: ${safeCause(error)}`);
        }
        return { status: 'published', packageName, version: FIRST_RELEASE_VERSION, integrity, authorizationNote };
    } finally {
        removeTempDirectory(temporaryDirectory);
    }
}

async function downloadSourceArchive(fetchArchive, sourceUrl, archiveFile, tag) {
    let response;
    try {
        response = await fetchArchive(sourceUrl);
    } catch (error) {
        throw new Error(`could not download source archive for ${tag}: ${safeCause(error)}`);
    }
    if (!response?.ok) {
        throw new Error(`source archive request for ${tag} failed with HTTP ${String(response?.status ?? 'unknown')}`);
    }
    try {
        fs.writeFileSync(archiveFile, Buffer.from(await response.arrayBuffer()));
    } catch (error) {
        throw new Error(`could not save source archive for ${tag}: ${safeCause(error)}`);
    }
}

function getSafeArchiveRoot(entriesValue) {
    const entries = normalizeTarEntries(entriesValue);
    if (entries.length === 0) throw new Error('source archive contains no entries');
    const roots = new Set();
    for (const entry of entries) {
        if (entry.includes('\0') || path.posix.isAbsolute(entry) || path.win32.isAbsolute(entry)) {
            throw new Error(`unsafe archive path: ${entry}`);
        }
        const segments = entry.split(/[\\/]/).filter((segment) => segment && segment !== '.');
        if (segments.includes('..') || segments.length === 0) throw new Error(`unsafe archive path: ${entry}`);
        roots.add(segments[0]);
    }
    if (roots.size !== 1) throw new Error('source archive must contain one top-level directory');
    return roots.values().next().value;
}

function normalizeTarEntries(entries) {
    return Array.isArray(entries) ? entries : parseTarEntries(String(entries));
}

function assertPathWithin(target, parent, description) {
    let absoluteTarget;
    let absoluteParent;
    try {
        absoluteTarget = fs.realpathSync(target);
        absoluteParent = fs.realpathSync(parent);
    } catch (error) {
        throw new Error(`${description} is missing or unreadable: ${safeCause(error)}`);
    }
    const relative = path.relative(absoluteParent, absoluteTarget);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`${description} escaped its allowed root`);
    }
}

function githubRepository(root) {
    const { repository } = readJson(path.join(root, 'package.json'), 'package.json');
    const url = typeof repository === 'string' ? repository : repository?.url;
    const slug = typeof url === 'string' ? url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] : undefined;
    if (!slug) throw new Error('package.json repository.url must name a GitHub repository');
    return slug;
}

function readJson(file, description) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`${description} is missing or malformed: ${safeCause(error)}`);
    }
}

async function readRegistryPackage(registry, packageName, version) {
    let result;
    try {
        result = await registry.getPackage(packageName);
    } catch (error) {
        throw new Error(`${packageName}@${version} registry check failed: ${safeCause(error)}`);
    }
    if (!result || !['found', 'missing', 'error'].includes(result.kind)) {
        throw new Error(`${packageName}@${version} registry check failed: malformed package response`);
    }
    if (result.kind === 'error') {
        throw new Error(`${packageName}@${version} registry check failed: ${safeCause(result.cause)}`);
    }
    return result;
}

async function readRegistryVersion(registry, packageName, version) {
    let result;
    try {
        result = await registry.getVersion(packageName, version);
    } catch (error) {
        throw new Error(`${packageName}@${version} registry check failed: ${safeCause(error)}`);
    }
    if (!result || !['found', 'not-found', 'error'].includes(result.kind)) {
        throw new Error(`${packageName}@${version} registry check failed: malformed version response`);
    }
    if (result.kind === 'error') {
        throw new Error(`${packageName}@${version} registry check failed: ${safeCause(result.cause)}`);
    }
    return result;
}

function assertRegistryIntegrity(integrity, label) {
    if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
        throw new Error(`${label} registry response has malformed dist.integrity`);
    }
}

function createArchiveAdapter(run) {
    return {
        async listEntries(archiveFile) {
            const result = run('tar', ['-tzf', archiveFile]);
            assertCommandSucceeded(result, 'tar source archive listing');
            const verbose = run('tar', ['-tvzf', archiveFile]);
            assertCommandSucceeded(verbose, 'tar source archive type listing');
            if (
                String(verbose.stdout)
                    .split(/\r?\n/)
                    .some((line) => /^[lh]/.test(line))
            ) {
                throw new Error('source archive contains a symbolic or hard link');
            }
            return parseTarEntries(result.stdout);
        },
        async extract(archiveFile, destination, archiveRoot) {
            const result = run('tar', ['-xzf', archiveFile, '-C', destination]);
            assertCommandSucceeded(result, 'tar source archive extraction');
            return path.join(destination, archiveRoot);
        },
        async install(sourceRoot) {
            const result = run('pnpm', ['install', '--frozen-lockfile'], { cwd: sourceRoot });
            assertCommandSucceeded(result, 'pnpm install --frozen-lockfile');
        },
        async pack(packageDirectory, destination) {
            return packAndInspect(packageDirectory, destination);
        },
    };
}

function createRegistryAdapter(run) {
    return {
        async getPackage(packageName) {
            const result = runNpmCommand(run, ['view', packageName, '--json', `--registry=${REGISTRY_URL}`]);
            if (isNpmNotFound(result)) return { kind: 'missing' };
            assertCommandSucceeded(result, `npm view ${packageName}`);
            let metadata;
            try {
                metadata = JSON.parse(result.stdout);
            } catch {
                return { kind: 'error', cause: 'malformed package metadata' };
            }
            if (!metadata || metadata.name !== packageName)
                return { kind: 'error', cause: 'registry returned malformed package metadata' };
            return { kind: 'found', name: metadata.name };
        },
        async getVersion(packageName, version) {
            const result = runNpmCommand(run, [
                'view',
                `${packageName}@${version}`,
                'dist.integrity',
                '--json',
                `--registry=${REGISTRY_URL}`,
            ]);
            if (isNpmNotFound(result)) return { kind: 'not-found' };
            assertCommandSucceeded(result, `npm view ${packageName}@${version}`);
            let integrity;
            try {
                integrity = JSON.parse(result.stdout);
            } catch {
                return { kind: 'error', cause: 'malformed dist.integrity response' };
            }
            return typeof integrity === 'string'
                ? { kind: 'found', integrity }
                : { kind: 'error', cause: 'registry response is missing dist.integrity' };
        },
    };
}

function runNpmCommand(run, args, options = {}) {
    return run('npm', args, { ...options, cwd: options.cwd ?? os.tmpdir() });
}

function createNpmAdapter(run) {
    return {
        async preflight({ packageName, packageExists, expectedOwner, confirmWriteAccess }) {
            if (typeof expectedOwner !== 'string' || !expectedOwner || confirmWriteAccess !== true) {
                throw new Error('expected npm owner and write-access confirmation are required');
            }
            const whoami = runNpmCommand(run, ['whoami', `--registry=${REGISTRY_URL}`]);
            assertCommandSucceeded(whoami, 'npm whoami');
            const username = whoami.stdout.trim();
            if (!username) throw new Error('npm whoami returned no authenticated username');
            if (username !== expectedOwner) {
                throw new Error(`authenticated npm account ${username} does not match expected owner ${expectedOwner}`);
            }

            const profile = runNpmCommand(run, ['profile', 'get', '--json', `--registry=${REGISTRY_URL}`]);
            assertCommandSucceeded(profile, 'npm profile get');
            if (!hasAccountTwoFactor(profile.stdout)) {
                throw new Error('npm account must have account-level 2FA enabled');
            }

            if (packageExists) {
                const owners = runNpmCommand(run, ['owner', 'ls', packageName, `--registry=${REGISTRY_URL}`]);
                assertCommandSucceeded(owners, `npm owner ls ${packageName}`);
                const ownerNames = parseNpmOwnerNames(owners.stdout);
                if (!ownerNames.includes(expectedOwner)) {
                    throw new Error(`expected package owner ${expectedOwner} was not present in npm owner ls`);
                }
                return {
                    username,
                    ownerConfirmed: true,
                    writeAccessConfirmed: true,
                    authorizationNote: `npm confirmed ${expectedOwner} owns ${packageName}; maintainer write-access confirmation was supplied.`,
                };
            }

            if (packageName.startsWith('@')) {
                const scope = packageName.slice(1, packageName.indexOf('/'));
                const membership = runNpmCommand(run, [
                    'org',
                    'ls',
                    scope,
                    username,
                    '--json',
                    `--registry=${REGISTRY_URL}`,
                ]);
                assertCommandSucceeded(membership, `npm org ls ${scope} ${username}`);
                if (!hasOrganizationMembership(membership.stdout, username)) {
                    throw new Error(`could not confirm ${username} belongs to npm organization @${scope}`);
                }
                return {
                    username,
                    ownerConfirmed: true,
                    writeAccessConfirmed: true,
                    authorizationNote: `npm confirmed ${expectedOwner} belongs to @${scope}; maintainer write-access confirmation was supplied. npm publish remains the final authorization check for ${packageName}.`,
                };
            }

            return {
                username,
                ownerConfirmed: true,
                writeAccessConfirmed: true,
                authorizationNote: `Maintainer confirmation identifies ${expectedOwner} as the intended owner and confirms write access; npm publish remains the final authorization check for ${packageName}.`,
            };
        },
        async publish(tarball, publishArguments) {
            const result = runNpmCommand(run, ['publish', tarball, ...publishArguments, `--registry=${REGISTRY_URL}`], {
                stdio: 'inherit',
            });
            assertCommandSucceeded(result, `npm publish ${path.basename(tarball)}`);
        },
    };
}

function parseNpmOwnerNames(output) {
    const lines = String(output)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 1 && lines[0].toLowerCase() === 'no admin found') return [];
    const names = lines.map((line) => {
        const entry = line.match(/^([^\s]+)\s+<[^<>]+>$/);
        if (!entry) throw new Error('npm owner ls returned an ambiguous owner entry');
        return entry[1];
    });
    return [...new Set(names)];
}

function hasAccountTwoFactor(output) {
    try {
        const { tfa } = JSON.parse(output);
        return Boolean(tfa) && !tfa.pending && ['auth-only', 'auth-and-writes'].includes(tfa.mode);
    } catch {
        return false;
    }
}

function hasOrganizationMembership(output, username) {
    try {
        const membership = JSON.parse(output);
        return (
            membership &&
            typeof membership === 'object' &&
            !Array.isArray(membership) &&
            ['developer', 'admin', 'owner'].includes(membership[username])
        );
    } catch {
        return false;
    }
}

function runCommand(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: options.stdio,
        windowsHide: true,
    });
    return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: result.error,
    };
}

function assertCommandSucceeded(result, description) {
    if (result?.error) throw new Error(`${description} could not start (${result.error.code ?? 'process error'})`);
    if (result?.status !== 0) {
        const cause =
            npmErrorCode(result?.stderr) ?? (result?.status === null ? 'process terminated' : `exit ${result?.status}`);
        throw new Error(`${description} failed (${cause})`);
    }
}

function isNpmNotFound(result) {
    return result?.status !== 0 && npmErrorCode(result?.stderr) === 'E404';
}

function npmErrorCode(stderr) {
    return String(stderr ?? '').match(/npm\s+(?:error|ERR!)\s+code\s+(E[A-Z0-9]+)/i)?.[1];
}

function safeCause(error) {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string' && error) return error;
    return 'unknown error';
}

/** Runs the bootstrap CLI without exposing npm authentication output. */
export async function main(args = process.argv.slice(2)) {
    try {
        const options = parseBootstrapArguments(args);
        const result = await bootstrapPublicTool(options, {
            onAuthorizationNote: (note) => console.log(note),
        });
        if (result.status === 'already-bootstrapped') {
            console.log(
                `${result.packageName}@${result.version} is already bootstrapped; registry integrity matches the packed tarball.`,
            );
        } else if (result.status === 'dry-run') {
            console.log(`Dry run passed for ${result.packageName}@${result.version}; no package was published.`);
        } else {
            console.log(`Published ${result.packageName}@${result.version}.`);
        }
    } catch (error) {
        console.error(`npm bootstrap failed: ${safeCause(error)}`);
        process.exitCode = 1;
    }
}

if (import.meta.main) await main();
