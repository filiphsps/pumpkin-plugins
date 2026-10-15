import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assertPublicToolPackage,
    assertPublicToolPackageContents,
    discoverPublicToolPackages,
    embeddedPackageManifestEntries,
    getPublicToolReleasePrerequisites,
    nodeEngineRange,
    orderPublicToolReleasePaths,
    parseTarEntries,
    publicToolPackageVersions,
} from './utils/tool-packages.mjs';

const rootDirectory = fileURLToPath(new URL('..', import.meta.url));
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Publishes selected public tools sequentially after validating their release tags, packed files,
 * exact prerequisites, and registry integrity.
 *
 * @param {object} options - Publication inputs and injectable package, registry, and publish adapters.
 * @param {string} options.root - Repository root that contains the selected tool packages.
 * @param {string[]} options.selectedPaths - Released workspace paths from Release Please.
 * @param {Record<string, unknown>} options.releaseMetadata - Release Please outputs keyed by path and field.
 * @param {(packagePath: string, root: string) => Promise<object>} [options.packPackage] - Creates and inspects one package tarball.
 * @param {(packageName: string, version: string) => Promise<string | null>} [options.getRegistryIntegrity] - Reads one exact version; null means definitive not found.
 * @param {(release: object) => Promise<void>} [options.publishPackage] - Publishes one verified tarball.
 * @param {(message: string) => void} [options.log] - Receives progress messages.
 * @returns {Promise<void>} Resolves after every selected package is published or verified as identical.
 * @throws {Error} When release metadata, package contents, dependencies, registry responses, or integrity disagree.
 */
export async function publishToolPackages({
    root,
    selectedPaths,
    releaseMetadata,
    packPackage = packPublicToolPackage,
    getRegistryIntegrity = getNpmRegistryIntegrity,
    publishPackage = publishNpmTarball,
    log = console.log,
}) {
    if (!Array.isArray(selectedPaths)) throw new Error('released tool paths must be a JSON array');
    if (!releaseMetadata || typeof releaseMetadata !== 'object' || Array.isArray(releaseMetadata)) {
        throw new Error('Release Please metadata must be a JSON object');
    }

    const toolsByPath = new Map(discoverPublicToolPackages(root).map((tool) => [tool.path, tool]));
    const packagePathByName = new Map([...toolsByPath.values()].map(({ path, name }) => [name, path]));
    const packageVersions = publicToolPackageVersions(root);
    const orderedPaths = orderPublicToolReleasePaths(selectedPaths, root);
    const selectedPathSet = new Set(orderedPaths);
    const completedVersions = new Map();

    for (const packagePath of orderedPaths) {
        const expectedName = toolsByPath.get(packagePath).name;
        const sourcePackageJson = readPackageJson(path.join(root, packagePath, 'package.json'));
        validateSourcePackage(sourcePackageJson, packagePath, root);
        const tag = releaseMetadata[`${packagePath}--tag_name`];
        const version = validateReleaseTag(packagePath, expectedName, sourcePackageJson.version, tag);
        const releaseLabel = `${expectedName}@${version}`;
        let packed;

        try {
            log(`Packing ${releaseLabel} from ${packagePath}`);
            packed = await packPackage(packagePath, root);
            validatePackedPackage(packagePath, expectedName, version, packed, root);
            const prerequisites = getPublicToolReleasePrerequisites(
                packagePath,
                packed.packageJson,
                packageVersions,
                packed.embeddedPackageJsons,
                root,
            );

            for (const prerequisite of prerequisites) {
                await assertPrerequisiteAvailable({
                    consumerName: expectedName,
                    consumerVersion: version,
                    prerequisite,
                    packagePathByName,
                    selectedPathSet,
                    completedVersions,
                    getRegistryIntegrity,
                });
            }

            const existingIntegrity = await getRegistryIntegrity(expectedName, version);
            validateRegistryIntegrityResult(existingIntegrity, expectedName, version);
            if (existingIntegrity !== null) {
                if (existingIntegrity !== packed.integrity) {
                    throw new Error(
                        `registry integrity mismatch: found ${existingIntegrity}, packed ${packed.integrity}`,
                    );
                }
                log(`${releaseLabel} is already published with matching integrity`);
            } else {
                log(`Publishing ${releaseLabel}`);
                await publishPackage({
                    packagePath,
                    packageName: expectedName,
                    version,
                    tag,
                    tarballPath: packed.tarballPath,
                    integrity: packed.integrity,
                });
            }
            completedVersions.set(expectedName, version);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed publishing ${releaseLabel}: ${detail}`, { cause: error });
        } finally {
            if (packed?.temporaryDirectory) {
                fs.rmSync(packed.temporaryDirectory, { recursive: true, force: true });
            }
        }
    }
}

function validateSourcePackage(packageJson, packagePath, root) {
    if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
        throw new Error(`${packagePath}/package.json must contain an object`);
    }
    const packageName = packageJson.name;
    if (typeof packageName !== 'string' || packageName.length === 0) {
        throw new Error(`${packagePath}/package.json must have a package name`);
    }
    if (packageJson.private === true) throw new Error(`${packageName} source package must not be private`);
    if (packageJson.publishConfig?.access !== 'public') {
        throw new Error(`${packageName} source publishConfig.access must be public`);
    }
    const expectedEngine = nodeEngineRange(root);
    if (packageJson.engines?.node !== expectedEngine) {
        throw new Error(`${packageName} source engines.node must be ${expectedEngine}`);
    }
    assertVersion(packageJson.version, `${packageName} source package version`);
}

function validateReleaseTag(packagePath, packageName, sourceVersion, tag) {
    if (typeof tag !== 'string' || tag.length === 0) {
        throw new Error(`${packagePath} is missing its Release Please tag_name`);
    }
    const component = path.posix.basename(packagePath);
    const prefix = `${component}-v`;
    if (!tag.startsWith(prefix)) {
        throw new Error(`${packagePath} release tag ${tag} must use component ${component}`);
    }
    const version = tag.slice(prefix.length);
    assertVersion(version, `${packagePath} release tag version`);
    if (version !== sourceVersion) {
        throw new Error(`${packageName}@${version} tag version differs from source manifest version ${sourceVersion}`);
    }
    return version;
}

function validatePackedPackage(packagePath, expectedName, version, packed, root) {
    if (!packed || typeof packed !== 'object' || Array.isArray(packed)) {
        throw new Error(`${packagePath} pack adapter did not return package metadata`);
    }
    if (typeof packed.integrity !== 'string' || packed.integrity.length === 0) {
        throw new Error(`${packagePath} packed tarball has no SRI integrity`);
    }
    assertPublicToolPackage(packed.packageJson, expectedName, root);
    if (packed.packageJson.version !== version) {
        throw new Error(
            `${expectedName}@${version} release tag version differs from packed manifest version ${String(
                packed.packageJson.version,
            )}`,
        );
    }
    assertPublicToolPackageContents(packed.entries, packagePath, packed.packageJson);
}

async function assertPrerequisiteAvailable({
    consumerName,
    consumerVersion,
    prerequisite,
    packagePathByName,
    selectedPathSet,
    completedVersions,
    getRegistryIntegrity,
}) {
    const prerequisitePath = packagePathByName.get(prerequisite.packageName);
    const requiredLabel = `${prerequisite.packageName}@${prerequisite.version}`;
    const consumerLabel = `${consumerName}@${consumerVersion}`;

    if (selectedPathSet.has(prerequisitePath)) {
        const completedVersion = completedVersions.get(prerequisite.packageName);
        if (!completedVersion) {
            throw new Error(`${requiredLabel} was selected in this run but has not completed before ${consumerLabel}`);
        }
        if (completedVersion !== prerequisite.version) {
            throw new Error(
                `${consumerLabel} requires ${requiredLabel}, but this run completed ${prerequisite.packageName}@${completedVersion}`,
            );
        }
        return;
    }

    const integrity = await getRegistryIntegrity(prerequisite.packageName, prerequisite.version);
    validateRegistryIntegrityResult(integrity, prerequisite.packageName, prerequisite.version);
    if (integrity === null) {
        throw new Error(`${requiredLabel} required by ${consumerLabel} was not found on npm`);
    }
}

function validateRegistryIntegrityResult(integrity, packageName, version) {
    if (integrity !== null && (typeof integrity !== 'string' || integrity.length === 0)) {
        throw new Error(`registry returned a malformed dist.integrity for ${packageName}@${version}`);
    }
}

function readPackageJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertVersion(version, label) {
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
        throw new Error(`${label} must be a semantic version; received ${String(version)}`);
    }
}

/**
 * Reads one exact public npm version after confirming its package exists on the public registry.
 *
 * @param {string} packageName - npm package name, including its scope when present.
 * @param {string} version - Exact semantic version to query.
 * @param {typeof fetch} [fetchImpl] - Fetch implementation used for the registry request.
 * @returns {Promise<string | null>} Registry integrity, or null only when the existing package's exact version returns 404.
 * @throws {Error} When the registry is unavailable or returns an unsuccessful or malformed response.
 */
export async function getNpmRegistryIntegrity(packageName, version, fetchImpl = fetch) {
    const packageUrl = encodeURIComponent(packageName);
    const versionUrl = encodeURIComponent(version);
    const packageResponse = await fetchImpl(`https://registry.npmjs.org/${packageUrl}`);
    if (packageResponse.status === 404) {
        throw new Error(
            `npm registry returned HTTP 404: package ${packageName} was not found; refusing to publish its first version from the automated publisher`,
        );
    }
    assertRegistryResponseOk(packageResponse);
    const packageDocument = await readRegistryJson(packageResponse);
    if (packageDocument?.name !== packageName) {
        throw new Error(`npm registry package lookup did not identify ${packageName}`);
    }

    const versionResponse = await fetchImpl(`https://registry.npmjs.org/${packageUrl}/${versionUrl}`);
    if (versionResponse.status === 404) return null;
    assertRegistryResponseOk(versionResponse);
    const registryPackage = await readRegistryJson(versionResponse);

    const integrity = registryPackage?.dist?.integrity;
    if (typeof integrity !== 'string' || integrity.length === 0) {
        throw new Error('npm registry response has no valid dist.integrity');
    }
    if (registryPackage.name !== packageName || registryPackage.version !== version) {
        throw new Error(
            `npm registry response identifies ${String(registryPackage.name)}@${String(
                registryPackage.version,
            )} rather than ${packageName}@${version}`,
        );
    }
    return integrity;
}

function assertRegistryResponseOk(response) {
    if (!response.ok) {
        throw new Error(`npm registry returned HTTP ${response.status} ${response.statusText}`);
    }
}

async function readRegistryJson(response) {
    try {
        return await response.json();
    } catch (error) {
        throw new Error('npm registry returned malformed JSON', { cause: error });
    }
}

function packPublicToolPackage(packagePath, root) {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-tool-package-'));
    try {
        const packageDirectory = path.join(root, packagePath);
        execFileSync('pnpm', ['pack', '--pack-destination', temporaryDirectory], {
            cwd: packageDirectory,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const tarballs = fs.readdirSync(temporaryDirectory).filter((file) => file.endsWith('.tgz'));
        if (tarballs.length !== 1) {
            throw new Error(`pnpm pack produced ${tarballs.length} tarballs for ${packagePath}; expected exactly one`);
        }
        const tarballPath = path.join(temporaryDirectory, tarballs[0]);
        const entries = parseTarEntries(execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' }));
        const packageJson = readPackedJson(tarballPath, 'package/package.json');
        const embeddedPackageJsons = embeddedPackageManifestEntries(entries).map((entry) =>
            readPackedJson(tarballPath, entry),
        );
        const integrity = `sha512-${createHash('sha512').update(fs.readFileSync(tarballPath)).digest('base64')}`;
        return { temporaryDirectory, tarballPath, entries, packageJson, embeddedPackageJsons, integrity };
    } catch (error) {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
        throw error;
    }
}

function readPackedJson(tarballPath, entry) {
    const contents = execFileSync('tar', ['-xOzf', tarballPath, entry], { encoding: 'utf8' });
    return JSON.parse(contents);
}

/**
 * Publishes a verified npm tarball with provenance from its temporary directory.
 *
 * @param {object} release - Verified package tarball.
 * @param {string} release.tarballPath - Path to the package tarball.
 * @returns {void} Completes after npm accepts the publish.
 * @throws {Error} When npm fails to publish the tarball.
 */
export function publishNpmTarball({ tarballPath }) {
    execFileSync('npm', ['publish', tarballPath, '--access', 'public', '--provenance'], {
        cwd: path.dirname(tarballPath),
        stdio: 'inherit',
    });
}

async function main() {
    const selectedPaths = JSON.parse(process.env.RELEASED_TOOL_PATHS ?? '[]');
    const releaseMetadata = JSON.parse(process.env.RELEASE_METADATA ?? '{}');
    await publishToolPackages({
        root: process.env.PUMPKIN_PUBLIC_TOOL_ROOT ?? rootDirectory,
        selectedPaths,
        releaseMetadata,
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
