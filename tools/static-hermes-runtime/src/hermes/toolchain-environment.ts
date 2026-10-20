import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createReadStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withHermesBuildLock } from './build.ts';
import { configuredExecutablePath, executablePath, findExecutable, wasiSdkCompilerPath } from './toolchain-paths.ts';

interface WasiSdkConfig {
    /** Trusted lowercase SHA-256 digests indexed by Node platform and architecture. */
    checksums: Record<string, string>;
    /** GitHub repository that publishes the release. */
    repository: string;
    /** Upstream WASI SDK release version. */
    version: string;
}

interface HermesToolchainConfig {
    tools: Record<string, string>;
}

interface WasmToolsLock {
    /** Trusted release archive names and lowercase SHA-256 digests indexed by Node platform and architecture. */
    assets: Record<string, { name: string; sha256: string }>;
    /** GitHub repository that publishes the release. */
    repository: string;
}

/** A pinned wasm-tools release archive for one platform. */
interface WasmToolsAsset {
    /** Trusted lowercase SHA-256 digest from the lock file. */
    digest: string;
    /** Archive filename. */
    name: string;
    /** HTTPS download URL. */
    url: string;
}

interface WasiSdkReleaseAsset {
    browser_download_url?: string;
    digest?: string;
    name: string;
}

interface WasiSdkRelease {
    assets?: WasiSdkReleaseAsset[];
}

/** Inputs for downloading, verifying, and installing a pinned WASI SDK archive. */
interface WasiSdkInstallOptions {
    /** Host architecture used to select the release asset. */
    arch: string;
    /** Cache directory where the SDK will be installed. */
    destination: string;
    /** Environment containing optional GitHub authentication. */
    env: NodeJS.ProcessEnv;
    /** Fetch implementation used for release metadata. */
    fetchImpl: typeof fetch;
    /** Host platform used to select the release asset. */
    platform: NodeJS.Platform;
    /** Upstream GitHub repository. */
    repository: string;
    /** Trusted lowercase archive digest from the local lockfile. */
    sha256: string;
    /** Pinned release version. */
    version: string;
}

/** Inputs needed to install a pinned wit-bindgen executable. */
interface WitBindgenInstallOptions {
    /** Destination path for the installed executable. */
    destination: string;
    /** Environment used when locating rustup, cargo, and related tools. */
    environment: NodeJS.ProcessEnv;
    /** User home directory used for Rust toolchain installation. */
    homeDirectory: string;
    /** Host platform used to resolve executable suffixes and tool archives. */
    platform: NodeJS.Platform;
    /** Rust toolchain version used to build wit-bindgen. */
    rustToolchainVersion: string;
    /** Pinned wit-bindgen release version. */
    version: string;
}

interface WasmToolsInstallOptions {
    arch: string;
    /** Release archive selected from `wasm-tools.lock.json`. */
    asset: WasmToolsAsset;
    destination: string;
    fetchImpl: typeof fetch;
    platform: NodeJS.Platform;
    version: string;
}

/** Options for installing or resolving the tools needed by a Static Hermes build. */
export interface HermesToolchainSetupOptions {
    /** Target architecture for tool downloads; defaults to the current host. */
    arch?: string;
    /** Environment used to resolve configured tool paths. */
    env?: NodeJS.ProcessEnv;
    /** Fetch implementation used to retrieve release metadata and archives. */
    fetchImpl?: typeof fetch;
    /** Home directory used for the shared toolchain cache. */
    homeDirectory?: string;
    /** Whether to resolve and validate the WASI SDK. */
    includeWasiSdk?: boolean;
    /** Whether to resolve and validate wasm-tools. */
    includeWasmTools?: boolean;
    /** Whether to resolve and validate wit-bindgen. */
    includeWitBindgen?: boolean;
    /** Installer hooks used by tests and custom package integrations. */
    installWasiSdk?: (options: WasiSdkInstallOptions) => Promise<string> | string;
    /** Installer hook for the pinned wasm-tools executable. */
    installWasmTools?: (options: WasmToolsInstallOptions) => Promise<string> | string;
    /** Installer hook for the pinned wit-bindgen executable. */
    installWitBindgen?: (options: WitBindgenInstallOptions) => Promise<string> | string;
    /** Target platform for tool downloads; defaults to the current host. */
    platform?: NodeJS.Platform;
    /** Pinned wit-bindgen, Rust, and wasm-tools versions. */
    toolchainConfig?: HermesToolchainConfig;
    /** WASI SDK version, GitHub repository, and trusted platform SHA-256 checksums. */
    wasiSdkConfig?: WasiSdkConfig;
    /** wasm-tools release repository and trusted platform archives for the pinned `tools.wasm-tools` version. */
    wasmToolsLock?: WasmToolsLock;
    /** Root of the `pumpkin-plugins` workspace. */
    workspaceRoot: string;
}

/** Setup and preparation hooks used before a component build. */
export interface StaticHermesBuildPreparationOptions {
    /** Environment used to select toolchain paths. */
    env?: NodeJS.ProcessEnv;
    /** Optional callback that prepares Hermes build artifacts. */
    prepare?: () => Promise<unknown> | unknown;
    /** Optional toolchain setup implementation. */
    setupEnvironment?: (options: HermesToolchainSetupOptions) => Promise<Record<string, string>>;
    /** Root of the `pumpkin-plugins` workspace. */
    workspaceRoot: string;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Compilers required from a WASI SDK by the Static Hermes C and C++ build paths. */
const requiredWasiSdkCompilers = ['wasm32-wasip2-clang', 'wasm32-wasip2-clang++'] as const;
const DEFAULT_WASI_SDK_CONFIG = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'wasi-sdk.lock.json'), 'utf8'),
) as WasiSdkConfig;
const DEFAULT_TOOLCHAIN_CONFIG = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'toolchain-versions.json'), 'utf8'),
) as HermesToolchainConfig;
const DEFAULT_WASM_TOOLS_LOCK = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'wasm-tools.lock.json'), 'utf8'),
) as WasmToolsLock;

/**
 * Resolve or install the selected tools needed by a Static Hermes build.
 *
 * @remarks
 * The WASI SDK and wit-bindgen are selected by default. `wasm-tools` is opt-in so callers that only need Hermes
 * preparation do not download it; component builds and WIT analysis enable it explicitly.
 * Valid cached tools are reused without a lock. Invalid cached `wasm-tools` binaries are removed and reinstalled
 * while holding the toolchain directory lock, which is separate from the Hermes build lock. A
 * configured `WASM_TOOLS` override is validated separately and is never removed by cache recovery.
 *
 * @param options - Workspace, environment, platform, cache, and tool-selection settings.
 * @returns Environment variables for the shared cache and each selected tool.
 * @throws {Error} If a configured tool is invalid, a platform has no pinned binary, or installation fails.
 */
export async function setupHermesToolchainEnvironment({
    workspaceRoot,
    env = process.env,
    platform = process.platform,
    arch = process.arch,
    homeDirectory = os.homedir(),
    includeWasiSdk = true,
    includeWitBindgen = true,
    includeWasmTools = false,
    wasiSdkConfig = DEFAULT_WASI_SDK_CONFIG,
    toolchainConfig = DEFAULT_TOOLCHAIN_CONFIG,
    wasmToolsLock = DEFAULT_WASM_TOOLS_LOCK,
    fetchImpl = globalThis.fetch,
    installWasiSdk = installPinnedWasiSdk,
    installWitBindgen = installPinnedWitBindgen,
    installWasmTools = installPinnedWasmTools,
}: HermesToolchainSetupOptions): Promise<Record<string, string>> {
    validateWasiSdkConfig(wasiSdkConfig);
    validateToolchainConfig(toolchainConfig);
    const cacheRoot = path.resolve(env.STATIC_HERMES_CACHE_DIR ?? path.join(workspaceRoot, '.cache/hermes'));
    const toolchainRoot = path.join(cacheRoot, 'toolchain');
    const environment: Record<string, string> = {
        STATIC_HERMES_CACHE_DIR: cacheRoot,
    };

    if (includeWasiSdk) {
        const configuredWasiSdk = env.STATIC_HERMES_WASI_SDK_PATH ?? env.WASI_SDK_PATH ?? env.WASI_SDK;
        const wasiSdkPath = configuredWasiSdk
            ? validateWasiSdk(path.resolve(configuredWasiSdk), 'configured WASI SDK', platform)
            : await resolveCachedWasiSdk({
                  toolchainRoot,
                  platform,
                  arch,
                  wasiSdkConfig,
                  env,
                  fetchImpl,
                  installWasiSdk,
              });
        environment.STATIC_HERMES_WASI_SDK_PATH = wasiSdkPath;
    }

    if (includeWitBindgen) {
        const version = toolchainConfig.tools['wit-bindgen'];
        const configuredBindgen = env.WIT_BINDGEN;
        const bindgenPath = configuredBindgen
            ? validateWitBindgen(
                  path.resolve(configuredExecutablePath(configuredBindgen, platform)),
                  version,
                  'configured wit-bindgen',
              )
            : await resolveWitBindgen({
                  toolchainRoot,
                  homeDirectory,
                  toolchainConfig,
                  environment: env,
                  platform,
                  installWitBindgen,
              });
        environment.WIT_BINDGEN = bindgenPath;
    }

    if (includeWasmTools) {
        const version = toolchainConfig.tools['wasm-tools'];
        if (typeof version !== 'string') throw new Error('toolchain-versions.json must provide tools.wasm-tools');
        const configuredWasmTools = env.WASM_TOOLS;
        const wasmToolsPath = configuredWasmTools
            ? validateWasmTools(path.resolve(configuredWasmTools), version, 'configured wasm-tools')
            : await resolveWasmTools({
                  toolchainRoot,
                  version,
                  asset: selectWasmToolsAsset(wasmToolsLock, { version, platform, arch }),
                  platform,
                  arch,
                  installWasmTools,
                  fetchImpl,
              });
        environment.WASM_TOOLS = wasmToolsPath;
    }

    return environment;
}

/**
 * Set up Hermes dependencies and prepare the pinned runtime before a component build.
 *
 * @remarks
 * This helper also selects `wasm-tools` for WIT resolution and skips repeated preparation when the environment
 * already has `PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED=1`.
 *
 * @param options - Workspace environment and optional setup and preparation hooks.
 */
export async function prepareStaticHermesBuild({
    workspaceRoot,
    env = process.env,
    setupEnvironment = setupHermesToolchainEnvironment,
    prepare = () => {
        const cli = path.join(packageRoot, 'dist/cli.js');
        execFileSync(process.execPath, [cli, 'hermes', 'prepare'], {
            cwd: workspaceRoot,
            env,
            stdio: 'inherit',
        });
    },
}: StaticHermesBuildPreparationOptions): Promise<void> {
    Object.assign(env, await setupEnvironment({ workspaceRoot, env, includeWasmTools: true }));
    if (env.PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED !== '1') await prepare();
}

/**
 * Serialize changes to the shared toolchain cache.
 *
 * @remarks
 * The toolchain directory has its own lock, so setup never waits for a Hermes build that holds the cache root's
 * `prepare.lock`.
 */
function withToolchainLock<T>(toolchainRoot: string, operation: () => Promise<T>): Promise<T> {
    return withHermesBuildLock(toolchainRoot, operation);
}

/** Reuse a valid cached WASI SDK or serialize cache repair and installation. */
async function resolveCachedWasiSdk({
    toolchainRoot,
    platform,
    arch,
    wasiSdkConfig,
    env,
    fetchImpl,
    installWasiSdk,
}: {
    toolchainRoot: string;
    platform: NodeJS.Platform;
    arch: string;
    wasiSdkConfig: WasiSdkConfig;
    env: NodeJS.ProcessEnv;
    fetchImpl: typeof fetch;
    installWasiSdk: NonNullable<HermesToolchainSetupOptions['installWasiSdk']>;
}): Promise<string> {
    const { repository, version } = wasiSdkConfig;
    const sha256 = wasiSdkConfig.checksums[`${platform}/${arch}`];
    if (!sha256) throw new Error(`no pinned WASI SDK ${version} SHA-256 checksum for ${platform}/${arch}`);
    const destination = path.join(toolchainRoot, `wasi-sdk-${version}`);
    if (isWasiSdk(destination, platform)) return destination;
    return withToolchainLock(toolchainRoot, async () => {
        if (isWasiSdk(destination, platform)) return destination;

        // Repair only the managed cache path; user-configured SDK paths are validated separately.
        fs.rmSync(destination, { recursive: true, force: true });
        const installed = await installWasiSdk({
            destination,
            platform,
            arch,
            repository,
            version,
            sha256,
            env,
            fetchImpl,
        });
        return validateWasiSdk(path.resolve(installed), 'automatically installed WASI SDK', platform);
    });
}

/** Reuse a cached or matching user-installed wit-bindgen, otherwise install its pinned version for the selected platform. */
async function resolveWitBindgen({
    toolchainRoot,
    homeDirectory,
    toolchainConfig,
    environment,
    platform,
    installWitBindgen,
}: {
    toolchainRoot: string;
    homeDirectory: string;
    toolchainConfig: HermesToolchainConfig;
    environment: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    installWitBindgen: NonNullable<HermesToolchainSetupOptions['installWitBindgen']>;
}): Promise<string> {
    const witBindgenVersion = toolchainConfig.tools['wit-bindgen'];
    const rustToolchainVersion = toolchainConfig.tools.rust;
    const destination = executablePath(
        path.join(toolchainRoot, `wit-bindgen-${witBindgenVersion}`, 'bin'),
        'wit-bindgen',
        platform,
    );
    const installRoot = path.dirname(path.dirname(destination));
    const userInstall = executablePath(path.join(homeDirectory, '.cargo', 'bin'), 'wit-bindgen', platform);
    if (fs.existsSync(destination)) {
        try {
            return validateWitBindgen(destination, witBindgenVersion, 'cached wit-bindgen');
        } catch {}
    }
    return withToolchainLock(toolchainRoot, async () => {
        if (fs.existsSync(destination)) {
            try {
                return validateWitBindgen(destination, witBindgenVersion, 'cached wit-bindgen');
            } catch {
                fs.rmSync(installRoot, { recursive: true, force: true });
            }
        }

        // Another wit-bindgen version in ~/.cargo/bin is left alone; the pinned one goes into the cache.
        if (fs.existsSync(userInstall)) {
            try {
                return validateWitBindgen(userInstall, witBindgenVersion, 'user-installed wit-bindgen');
            } catch {}
        }

        // Remove an interrupted cargo install before starting a fresh installation.
        fs.rmSync(installRoot, { recursive: true, force: true });
        try {
            const installed = await installWitBindgen({
                destination,
                version: witBindgenVersion,
                rustToolchainVersion,
                homeDirectory,
                environment,
                platform,
            });
            return validateWitBindgen(
                path.resolve(installed),
                witBindgenVersion,
                'automatically installed wit-bindgen',
            );
        } catch (error) {
            fs.rmSync(installRoot, { recursive: true, force: true });
            throw error;
        }
    });
}

/** Reuse a valid cached wasm-tools binary, replace an invalid cache entry, or install the pinned release archive. */
async function resolveWasmTools({
    toolchainRoot,
    version,
    asset,
    platform,
    arch,
    installWasmTools,
    fetchImpl,
}: {
    toolchainRoot: string;
    version: string;
    asset: WasmToolsAsset;
    platform: NodeJS.Platform;
    arch: string;
    installWasmTools: NonNullable<HermesToolchainSetupOptions['installWasmTools']>;
    fetchImpl: typeof fetch;
}): Promise<string> {
    const binaryName = platform === 'win32' ? 'wasm-tools.exe' : 'wasm-tools';
    const executable = path.join(toolchainRoot, `wasm-tools-${version}`, 'bin', binaryName);
    const installRoot = path.dirname(path.dirname(executable));
    if (fs.existsSync(executable)) {
        try {
            return validateWasmTools(executable, version, 'cached wasm-tools');
        } catch {}
    }

    return withToolchainLock(toolchainRoot, async () => {
        if (fs.existsSync(executable)) {
            try {
                return validateWasmTools(executable, version, 'cached wasm-tools');
            } catch {
                fs.rmSync(installRoot, { recursive: true, force: true });
            }
        } else {
            fs.rmSync(installRoot, { recursive: true, force: true });
        }

        try {
            const installed = await installWasmTools({
                destination: executable,
                version,
                asset,
                platform,
                arch,
                fetchImpl,
            });
            return validateWasmTools(path.resolve(installed), version, 'automatically installed wasm-tools');
        } catch (error) {
            try {
                return validateWasmTools(executable, version, 'cached wasm-tools');
            } catch {
                fs.rmSync(installRoot, { recursive: true, force: true });
                throw error;
            }
        }
    });
}

/** Download, verify, extract, and cache the pinned wasm-tools release. */
async function installPinnedWasmTools({
    destination,
    version,
    asset,
    platform,
    fetchImpl = globalThis.fetch,
}: WasmToolsInstallOptions): Promise<string> {
    const installRoot = path.dirname(path.dirname(destination));
    const parent = path.dirname(installRoot);
    fs.mkdirSync(parent, { recursive: true });
    const installationDirectory = fs.mkdtempSync(path.join(parent, `wasm-tools-${version}.install-`));
    const archive = path.join(installationDirectory, 'wasm-tools.archive');
    const extraction = path.join(installationDirectory, 'extracted');
    const staging = path.join(installationDirectory, 'toolchain');
    try {
        const response = await fetchImpl(asset.url);
        if (!response.ok) throw new Error(`Could not download ${asset.name}: HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const actualDigest = createHash('sha256').update(bytes).digest('hex');
        if (actualDigest !== asset.digest) {
            throw new Error(`wasm-tools checksum mismatch: expected ${asset.digest}, received ${actualDigest}`);
        }
        fs.writeFileSync(archive, bytes);
        fs.mkdirSync(extraction, { recursive: true });
        fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });
        execFileSync('tar', ['-xf', archive, '--strip-components=1', '-C', extraction], { stdio: 'inherit' });
        const binaryName = platform === 'win32' ? 'wasm-tools.exe' : 'wasm-tools';
        const extractedBinary = path.join(extraction, binaryName);
        if (!fs.existsSync(extractedBinary)) throw new Error(`${asset.name} did not contain ${binaryName}`);
        const stagedBinary = path.join(staging, 'bin', binaryName);
        fs.copyFileSync(extractedBinary, stagedBinary);
        if (platform !== 'win32') fs.chmodSync(stagedBinary, 0o755);
        validateWasmTools(stagedBinary, version, 'downloaded wasm-tools');
        try {
            fs.renameSync(staging, installRoot);
        } catch (error) {
            if (fs.existsSync(path.join(installRoot, 'bin', binaryName))) {
                return path.join(installRoot, 'bin', binaryName);
            }
            throw error;
        }
        return path.join(installRoot, 'bin', binaryName);
    } finally {
        fs.rmSync(installationDirectory, { recursive: true, force: true });
    }
}

/** Download, verify, and install the configured WASI SDK release. */
async function installPinnedWasiSdk({
    destination,
    platform,
    arch,
    repository,
    version,
    sha256,
    env,
    fetchImpl,
}: WasiSdkInstallOptions): Promise<string> {
    const parent = path.dirname(destination);
    fs.mkdirSync(parent, { recursive: true });
    const installationDirectory = fs.mkdtempSync(path.join(parent, `${path.basename(destination)}.install-`));
    const archive = path.join(installationDirectory, 'sdk.tar.gz');
    const extraction = path.join(installationDirectory, 'sdk');
    try {
        const release = await fetchWasiSdkRelease({
            repository,
            version,
            token: env.GITHUB_TOKEN ?? env.GH_TOKEN,
            fetchImpl,
        });
        const asset = selectWasiSdkAsset(release, { version, platform, arch, expectedSha256: sha256 });
        execFileSync(
            'curl',
            ['--fail', '--location', '--retry', '3', asset.browser_download_url, '--output', archive],
            { stdio: 'inherit' },
        );
        await verifyWasiSdkArchiveChecksum(archive, sha256);

        fs.mkdirSync(extraction, { recursive: true });
        execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', extraction], { stdio: 'inherit' });
        validateWasiSdk(extraction, 'downloaded WASI SDK', platform);
        return publishWasiSdkDirectory(extraction, destination, platform);
    } finally {
        fs.rmSync(installationDirectory, { recursive: true, force: true });
    }
}

/**
 * Publish a validated SDK in the shared cache, keeping a complete concurrent installation.
 *
 * @param extraction - Directory containing the validated SDK.
 * @param destination - Shared cache directory for this SDK version.
 * @param platform - Host platform used to check the SDK compiler suffix.
 * @returns The shared SDK directory.
 * @throws {Error} If the destination exists but does not contain a complete SDK.
 */
export function publishWasiSdkDirectory(
    extraction: string,
    destination: string,
    platform: NodeJS.Platform = process.platform,
): string {
    try {
        fs.renameSync(extraction, destination);
    } catch (error) {
        if (isWasiSdk(destination, platform)) return destination;
        if (fs.existsSync(destination)) {
            throw new Error(`WASI SDK cache is incomplete at ${destination}; remove it and retry`, { cause: error });
        }
        throw error;
    }
    return destination;
}

/**
 * Fetch GitHub release metadata used to discover WASI SDK archives and their published digests.
 *
 * @param options - Repository URL, SDK version, optional GitHub token, and fetch implementation.
 * @returns GitHub release metadata for the pinned SDK version.
 * @throws {Error} If the repository is not hosted on GitHub or the release request fails.
 */
export async function fetchWasiSdkRelease({
    repository,
    version,
    token,
    fetchImpl = globalThis.fetch,
}: {
    repository: string;
    version: string;
    token?: string;
    fetchImpl?: typeof fetch;
}): Promise<WasiSdkRelease> {
    const repositoryUrl = new URL(repository);
    if (repositoryUrl.hostname !== 'github.com') {
        throw new Error(`WASI SDK release metadata must be hosted on GitHub: ${repository}`);
    }
    const repositoryPath = repositoryUrl.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    const url = `https://api.github.com/repos/${repositoryPath}/releases/tags/wasi-sdk-${version}`;
    const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetchImpl(url, { headers });
    if (!response.ok) {
        throw new Error(
            `Could not fetch WASI SDK ${version} release metadata: GitHub returned HTTP ${response.status}`,
        );
    }
    return (await response.json()) as WasiSdkRelease;
}

/**
 * Find a matching WASI SDK archive in the GitHub release asset list.
 *
 * @param release - GitHub release metadata containing its published assets.
 * @param target - SDK version, platform, and architecture to match.
 * @returns The matching asset, including its HTTPS download URL and published SHA-256 digest.
 * @throws {Error} If the release has no matching archive, its digest differs from the trusted pin, or its URL is invalid.
 */
export function selectWasiSdkAsset(
    release: WasiSdkRelease,
    {
        version,
        platform,
        arch,
        expectedSha256,
    }: { version: string; platform: NodeJS.Platform; arch: string; expectedSha256: string },
): WasiSdkReleaseAsset & { digest: string; browser_download_url: string } {
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
        throw new Error(`WASI SDK ${version} has no valid pinned SHA-256 checksum for ${platform}/${arch}`);
    }
    const wasiOsByPlatform: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macos', win32: 'windows' };
    const wasiOs = wasiOsByPlatform[platform] ?? platform;
    const wasiArch = ({ x64: 'x86_64' } as Record<string, string>)[arch] ?? arch;
    const escapedVersion = escapeRegExp(version);
    const archivePattern = new RegExp(
        `^wasi-sdk-${escapedVersion}(?:\\.\\d+)?-${escapeRegExp(wasiArch)}-${escapeRegExp(wasiOs)}\\.tar\\.gz$`,
    );
    const asset = release.assets?.find(({ name }) => archivePattern.test(name));
    if (!asset) {
        throw new Error(`no WASI SDK ${version} archive for ${platform}/${arch} in the configured GitHub release`);
    }
    const digest = asset.digest;
    if (!digest || !/^sha256:[0-9a-f]{64}$/i.test(digest)) {
        throw new Error(`WASI SDK archive ${asset.name} has no SHA-256 digest in GitHub release metadata`);
    }
    if (digest.toLowerCase() !== `sha256:${expectedSha256}`) {
        throw new Error(
            `WASI SDK archive ${asset.name} SHA-256 ${digest.slice('sha256:'.length)} does not match the pinned SHA-256 ${expectedSha256}`,
        );
    }
    const browserDownloadUrl = asset.browser_download_url;
    if (typeof browserDownloadUrl !== 'string' || new URL(browserDownloadUrl).protocol !== 'https:') {
        throw new Error(`WASI SDK archive ${asset.name} has no valid HTTPS download URL`);
    }
    return { ...asset, digest, browser_download_url: browserDownloadUrl };
}

/**
 * Verify a downloaded WASI SDK archive against its trusted lockfile checksum.
 *
 * @param archivePath - Path to the downloaded SDK archive.
 * @param expectedSha256 - Trusted lowercase SHA-256 digest from the lockfile.
 * @throws {Error} If the archive bytes do not match the lockfile digest.
 */
export async function verifyWasiSdkArchiveChecksum(archivePath: string, expectedSha256: string): Promise<void> {
    const actualSha256 = await sha256File(archivePath);
    if (actualSha256 !== expectedSha256) {
        throw new Error(`WASI SDK checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`);
    }
}

/**
 * Return the pinned wasm-tools archive and checksum for a supported platform.
 *
 * @param lock - Release repository and per-platform archives from `wasm-tools.lock.json`.
 * @param target - Pinned release version, platform, and architecture.
 * @returns Archive filename, HTTPS download URL, and lowercase SHA-256 digest.
 * @throws {Error} If the lock does not pin assets for the version or has no binary for the platform/architecture pair.
 */
export function selectWasmToolsAsset(
    lock: WasmToolsLock,
    {
        version,
        platform,
        arch,
    }: {
        version: string;
        platform: NodeJS.Platform;
        arch: string;
    },
): WasmToolsAsset {
    validateWasmToolsLock(lock, version);
    const asset = lock.assets[`${platform}/${arch}`];
    if (!asset) throw new Error(`no pinned wasm-tools ${version} binary for ${platform}/${arch}`);
    const repository = lock.repository.replace(/\/+$/, '');
    return {
        name: asset.name,
        url: `${repository}/releases/download/v${version}/${asset.name}`,
        digest: asset.sha256,
    };
}

/** Validate that the wasm-tools lock pins HTTPS release archives and SHA-256 digests for one version. */
function validateWasmToolsLock(lock: WasmToolsLock, version: string): void {
    const archiveName = new RegExp(`^wasm-tools-${escapeRegExp(version)}-[a-z0-9_]+-[a-z0-9_]+\\.(?:tar\\.gz|zip)$`);
    if (
        !lock ||
        typeof lock.repository !== 'string' ||
        !lock.repository.startsWith('https://') ||
        !lock.assets ||
        typeof lock.assets !== 'object' ||
        Array.isArray(lock.assets) ||
        Object.keys(lock.assets).length === 0 ||
        Object.entries(lock.assets).some(
            ([target, asset]) =>
                !/^(?:darwin|linux|win32)\/(?:arm64|riscv64|x64)$/.test(target) ||
                typeof asset?.name !== 'string' ||
                !archiveName.test(asset.name) ||
                typeof asset.sha256 !== 'string' ||
                !/^[0-9a-f]{64}$/.test(asset.sha256),
        )
    ) {
        throw new Error(
            `wasm-tools.lock.json must pin wasm-tools ${version} release archives with platform SHA-256 checksums`,
        );
    }
}

/** Validate the WASI SDK version, release repository, and per-target SHA-256 pins. */
function validateWasiSdkConfig(config: WasiSdkConfig): void {
    if (
        !config ||
        typeof config.version !== 'string' ||
        !/^\d+(?:\.\d+)?$/.test(config.version) ||
        typeof config.repository !== 'string' ||
        !config.checksums ||
        typeof config.checksums !== 'object' ||
        Array.isArray(config.checksums) ||
        Object.keys(config.checksums).length === 0 ||
        Object.entries(config.checksums).some(
            ([target, digest]) =>
                !/^(?:darwin|linux|win32)\/(?:arm64|riscv64|x64)$/.test(target) ||
                typeof digest !== 'string' ||
                !/^[0-9a-f]{64}$/.test(digest),
        )
    ) {
        throw new Error(
            'wasi-sdk.lock.json must provide a numeric version, GitHub repository URL, and platform SHA-256 checksums',
        );
    }
}

/** Validate the pinned wit-bindgen and Rust tool versions. */
function validateToolchainConfig(config: HermesToolchainConfig): void {
    if (
        !config?.tools ||
        typeof config.tools['wit-bindgen'] !== 'string' ||
        !/^\d+(?:\.\d+){1,2}$/.test(config.tools['wit-bindgen']) ||
        typeof config.tools.rust !== 'string' ||
        !/^\d+\.\d+\.\d+$/.test(config.tools.rust)
    ) {
        throw new Error('toolchain-versions.json must provide numeric tools.wit-bindgen and tools.rust versions');
    }
}

/** Escape regular expression metacharacters in a literal value. */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Install the pinned wit-bindgen release using rustup or an available cargo toolchain. */
async function installPinnedWitBindgen({
    destination,
    version,
    rustToolchainVersion,
    homeDirectory,
    environment,
    platform,
}: WitBindgenInstallOptions): Promise<string> {
    const installRoot = path.dirname(path.dirname(destination));
    fs.mkdirSync(installRoot, { recursive: true });
    const rustup =
        findExecutable('rustup', environment, platform) ??
        executablePath(path.join(homeDirectory, '.cargo', 'bin'), 'rustup', platform);
    if (fs.existsSync(rustup)) {
        execFileSync(rustup, ['toolchain', 'install', rustToolchainVersion, '--profile', 'minimal'], {
            stdio: 'inherit',
        });
        execFileSync(
            rustup,
            [
                'run',
                rustToolchainVersion,
                'cargo',
                'install',
                'wit-bindgen-cli',
                '--version',
                version,
                '--locked',
                '--root',
                installRoot,
            ],
            { stdio: 'inherit' },
        );
    } else {
        const cargo =
            findExecutable('cargo', environment, platform) ??
            executablePath(path.join(homeDirectory, '.cargo', 'bin'), 'cargo', platform);
        if (!fs.existsSync(cargo)) {
            throw new Error(
                `Static Hermes needs wit-bindgen ${version}; install Rust with rustup or set WIT_BINDGEN to an existing executable`,
            );
        }
        execFileSync(cargo, ['install', 'wit-bindgen-cli', '--version', version, '--locked', '--root', installRoot], {
            stdio: 'inherit',
        });
    }

    return destination;
}

/** Check whether a WASI SDK directory contains its platform-specific target C and C++ compilers.
 *
 * @param directory - WASI SDK directory to inspect.
 * @param platform - Host platform used to resolve the compiler executable suffix.
 * @returns `true` when both target compilers exist.
 */
function isWasiSdk(directory: string, platform: NodeJS.Platform): boolean {
    return requiredWasiSdkCompilers.every((compiler) =>
        fs.existsSync(wasiSdkCompilerPath(directory, compiler, platform)),
    );
}

/** Validate a WASI SDK directory and return its path.
 *
 * @param directory - SDK directory to inspect.
 * @param description - Source label included in validation errors.
 * @param platform - Host platform that determines the expected compiler executable suffix.
 * @returns The validated SDK directory.
 * @throws {Error} If either SDK target compiler is missing.
 */
function validateWasiSdk(directory: string, description: string, platform: NodeJS.Platform): string {
    const missingCompiler = requiredWasiSdkCompilers
        .map((compiler) => wasiSdkCompilerPath(directory, compiler, platform))
        .find((compilerPath) => !fs.existsSync(compilerPath));
    if (missingCompiler) {
        throw new Error(`${description} is missing bin/${path.basename(missingCompiler)}: ${directory}`);
    }
    return directory;
}

/** Validate a wit-bindgen executable path, run it, and ensure it matches the pinned version. */
function validateWitBindgen(executable: string, version: string, description: string): string {
    if (!fs.existsSync(executable)) throw new Error(`${description} executable not found: ${executable}`);
    let output: string;
    try {
        output = execFileSync(executable, ['--version'], { encoding: 'utf8' });
    } catch (error) {
        throw new Error(`${description} could not run: ${executable}`, { cause: error });
    }
    if (!new RegExp(`^wit-bindgen-cli ${escapeRegExp(version)}(?:\\s|$)`).test(output.trim())) {
        throw new Error(`${description} must be wit-bindgen-cli ${version}: ${output.trim()}`);
    }
    return executable;
}

/** Validate a wasm-tools executable and ensure it matches the pinned version. */
function validateWasmTools(executable: string, version: string, description: string): string {
    if (!fs.existsSync(executable)) throw new Error(`${description} executable not found: ${executable}`);
    let output: string;
    try {
        output = execFileSync(executable, ['--version'], { encoding: 'utf8' });
    } catch (error) {
        throw new Error(`${description} could not run: ${executable}`, { cause: error });
    }
    if (!new RegExp(`^wasm-tools ${escapeRegExp(version)}(?:\\s|$)`).test(output.trim())) {
        throw new Error(`${description} must be wasm-tools ${version}: ${output.trim()}`);
    }
    return executable;
}

/** Compute a file's SHA-256 digest by streaming its contents. */
async function sha256File(filename: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
}
