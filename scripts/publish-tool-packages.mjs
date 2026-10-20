import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    assertPublicToolPackage,
    assertPublicToolPackageContents,
    compareVersions,
    discoverPublicToolPackages,
    getPublicToolReleasePrerequisites,
    nodeEngineRange,
    orderPublicToolReleasePaths,
    packAndInspect,
    publicToolPackageVersions,
} from './utils/tool-packages.mjs';

const rootDirectory = path.resolve(import.meta.dirname, '..');
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REGISTRY_VISIBILITY_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 30_000, 30_000];

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Publishes selected public tools sequentially after validating their release tags, packed files,
 * exact prerequisites, and registry integrity.
 *
 * @param {object} options - Publication inputs and injectable package, registry, and publish adapters.
 * @param {string} options.root - Repository root that contains the selected tool packages.
 * @param {string[]} options.selectedPaths - Released workspace paths from Release Please.
 * @param {Record<string, unknown>} options.releaseMetadata - Release Please outputs keyed by path and field.
 * @param {(packagePath: string, root: string) => object | Promise<object>} [options.packPackage] - Creates and inspects one package tarball.
 * @param {(packageName: string, version: string) => Promise<string | null>} [options.getRegistryIntegrity] - Reads one exact version; null means it is not currently visible.
 * @param {(release: object) => void | Promise<void>} [options.publishPackage] - Publishes one verified tarball.
 * @param {(message: string) => void} [options.log] - Receives progress messages.
 * @param {(milliseconds: number) => Promise<void>} [options.waitForRegistry] - Waits for a delay in milliseconds before retrying a missing prerequisite.
 * @returns {Promise<void>} Resolves after every selected package is published or verified as identical.
 * @throws {Error} When release metadata, package contents, dependencies, registry responses, or integrity disagree.
 */
export async function publishToolPackages({
    root,
    selectedPaths,
    releaseMetadata,
    packPackage = packPublicToolPackage,
    getRegistryIntegrity = getNpmRegistryIntegrity,
    publishPackage = publishToNpm,
    log = console.log,
    waitForRegistry = wait,
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
                    waitForRegistry,
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
    waitForRegistry,
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

    let integrity = await getRegistryIntegrity(prerequisite.packageName, prerequisite.version);
    validateRegistryIntegrityResult(integrity, prerequisite.packageName, prerequisite.version);
    for (const delayMs of REGISTRY_VISIBILITY_RETRY_DELAYS_MS) {
        if (integrity !== null) return;
        await waitForRegistry(delayMs);
        integrity = await getRegistryIntegrity(prerequisite.packageName, prerequisite.version);
        validateRegistryIntegrityResult(integrity, prerequisite.packageName, prerequisite.version);
    }
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
 * Reads the integrity of one exact public npm version from its package document.
 *
 * @param {string} packageName - npm package name, including its scope when present.
 * @param {string} version - Exact semantic version to query.
 * @param {typeof fetch} [fetchImpl] - Fetch implementation used for the registry request.
 * @returns {Promise<string | null>} Registry integrity, or null when the existing package does not list the version.
 * @throws {Error} When the package is missing, or the registry is unavailable or returns a malformed response.
 */
export async function getNpmRegistryIntegrity(packageName, version, fetchImpl = fetch) {
    const registryPackage = (await readNpmPackument(packageName, fetchImpl)).versions[version];
    if (registryPackage === undefined) return null;

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

/**
 * Lists the versions already published for a public npm package.
 *
 * @param {string} packageName - npm package name, including its scope when present.
 * @param {typeof fetch} [fetchImpl] - Fetch implementation used for the registry request.
 * @returns {Promise<string[]>} Exact versions currently listed by the npm registry.
 * @throws {Error} When the package is missing or the registry response is unsuccessful or malformed.
 */
export async function getNpmRegistryVersions(packageName, fetchImpl = fetch) {
    return Object.keys((await readNpmPackument(packageName, fetchImpl)).versions);
}

async function readNpmPackument(packageName, fetchImpl) {
    const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
    if (response.status === 404) {
        throw new Error(
            `npm registry returned HTTP 404: package ${packageName} was not found; refusing to publish its first version from the automated publisher`,
        );
    }
    assertRegistryResponseOk(response);
    const packument = await readRegistryJson(response);
    if (packument?.name !== packageName) {
        throw new Error(`npm registry package lookup did not identify ${packageName}`);
    }
    if (!packument.versions || typeof packument.versions !== 'object' || Array.isArray(packument.versions)) {
        throw new Error(`npm registry response has no valid versions map for ${packageName}`);
    }
    return packument;
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
        return { temporaryDirectory, ...packAndInspect(path.join(root, packagePath), temporaryDirectory) };
    } catch (error) {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
        throw error;
    }
}

/**
 * Picks the npm dist-tag for a release so that publishing an older version leaves `latest` alone.
 *
 * @param {string} version - Version being published.
 * @param {string | undefined} latestVersion - The registry's current `latest` dist-tag, if any.
 * @returns {'latest' | 'backfill'} `latest` for a version above the current latest, otherwise `backfill`.
 * @throws {Error} When the version is a prerelease, which the automated publisher does not tag.
 */
export function npmDistTag(version, latestVersion) {
    if (version.split('+')[0].includes('-')) throw new Error(`prerelease ${version} has no automated npm dist-tag`);
    return latestVersion === undefined || compareVersions(version, latestVersion) > 0 ? 'latest' : 'backfill';
}

async function publishToNpm({ packageName, version, tarballPath }) {
    const latestVersion = (await readNpmPackument(packageName, fetch))['dist-tags']?.latest;
    publishNpmTarball({ tarballPath, distTag: npmDistTag(version, latestVersion) });
}

/**
 * Publishes a verified npm tarball with provenance from its temporary directory.
 *
 * @param {object} release - Verified package tarball.
 * @param {string} release.tarballPath - Path to the package tarball.
 * @param {string} release.distTag - npm dist-tag the version receives.
 * @returns {void} Completes after npm accepts the publish.
 * @throws {Error} When npm fails to publish the tarball.
 */
export function publishNpmTarball({ tarballPath, distTag }) {
    execFileSync('npm', ['publish', tarballPath, '--access', 'public', '--provenance', '--tag', distTag], {
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

if (import.meta.main) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
