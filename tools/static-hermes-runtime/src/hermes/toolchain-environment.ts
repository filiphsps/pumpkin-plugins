import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createReadStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredExecutablePath, executablePath, findExecutable, wasiSdkCompilerPath } from './toolchain-paths.ts';

interface WasiSdkConfig {
    version: string;
    repository: string;
}

interface HermesToolchainConfig {
    tools: Record<string, string>;
}

interface WasiSdkReleaseAsset {
    name: string;
    digest?: string;
    browser_download_url?: string;
}

interface WasiSdkRelease {
    assets?: WasiSdkReleaseAsset[];
}

interface WasiSdkInstallOptions {
    destination: string;
    platform: NodeJS.Platform;
    arch: string;
    repository: string;
    version: string;
    env: NodeJS.ProcessEnv;
    fetchImpl: typeof fetch;
}

/** Inputs needed to install a pinned wit-bindgen executable. */
interface WitBindgenInstallOptions {
    /** Destination path for the installed executable. */
    destination: string;
    /** Pinned wit-bindgen release version. */
    version: string;
    /** Rust toolchain version used to build wit-bindgen. */
    rustToolchainVersion: string;
    /** User home directory used for Rust toolchain installation. */
    homeDirectory: string;
    /** Environment used when locating rustup, cargo, and related tools. */
    environment: NodeJS.ProcessEnv;
    /** Host platform used to resolve executable suffixes and tool archives. */
    platform: NodeJS.Platform;
}

interface WasmToolsInstallOptions {
    destination: string;
    version: string;
    platform: NodeJS.Platform;
    arch: string;
    fetchImpl: typeof fetch;
}

/** Options for installing or resolving the tools needed by a Static Hermes build. */
export interface HermesToolchainSetupOptions {
    /** Root of the `pumpkin-plugins` workspace. */
    workspaceRoot: string;
    /** Environment used to resolve configured tool paths. */
    env?: NodeJS.ProcessEnv;
    /** Target platform for tool downloads; defaults to the current host. */
    platform?: NodeJS.Platform;
    /** Target architecture for tool downloads; defaults to the current host. */
    arch?: string;
    /** Home directory used for the shared toolchain cache. */
    homeDirectory?: string;
    /** Whether to resolve and validate the WASI SDK. */
    includeWasiSdk?: boolean;
    /** Whether to resolve and validate wit-bindgen. */
    includeWitBindgen?: boolean;
    /** Whether to resolve and validate wasm-tools. */
    includeWasmTools?: boolean;
    /** Version and GitHub repository used to resolve the WASI SDK release. */
    wasiSdkConfig?: WasiSdkConfig;
    /** Pinned wit-bindgen, Rust, and wasm-tools versions. */
    toolchainConfig?: HermesToolchainConfig;
    /** Fetch implementation used to retrieve release metadata and archives. */
    fetchImpl?: typeof fetch;
    /** Installer hooks used by tests and custom package integrations. */
    installWasiSdk?: (options: WasiSdkInstallOptions) => Promise<string> | string;
    /** Installer hook for the pinned wit-bindgen executable. */
    installWitBindgen?: (options: WitBindgenInstallOptions) => Promise<string> | string;
    /** Installer hook for the pinned wasm-tools executable. */
    installWasmTools?: (options: WasmToolsInstallOptions) => Promise<string> | string;
}

/** Setup and preparation hooks used before a component build. */
export interface StaticHermesBuildPreparationOptions {
    /** Root of the `pumpkin-plugins` workspace. */
    workspaceRoot: string;
    /** Environment used to select toolchain paths. */
    env?: NodeJS.ProcessEnv;
    /** Optional toolchain setup implementation. */
    setupEnvironment?: (options: HermesToolchainSetupOptions) => Promise<Record<string, string>>;
    /** Optional callback that prepares Hermes build artifacts. */
    prepare?: () => Promise<unknown> | unknown;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_WASI_SDK_CONFIG = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'wasi-sdk.lock.json'), 'utf8')
) as WasiSdkConfig;
const DEFAULT_TOOLCHAIN_CONFIG = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'toolchain-versions.json'), 'utf8')
) as HermesToolchainConfig;

/**
 * Resolve or install the selected tools needed by a Static Hermes build.
 *
 * @remarks
 * The WASI SDK and wit-bindgen are selected by default. `wasm-tools` is opt-in so callers that only need Hermes
 * preparation do not download it; component builds and WIT analysis enable it explicitly.
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
    fetchImpl = globalThis.fetch,
    installWasiSdk = installPinnedWasiSdk,
    installWitBindgen = installPinnedWitBindgen,
    installWasmTools = installPinnedWasmTools
}: HermesToolchainSetupOptions): Promise<Record<string, string>> {
    validateWasiSdkConfig(wasiSdkConfig);
    validateToolchainConfig(toolchainConfig);
    const cacheRoot = path.resolve(env.STATIC_HERMES_CACHE_DIR ?? path.join(workspaceRoot, '.cache/hermes'));
    const toolchainRoot = path.join(cacheRoot, 'toolchain');
    const environment: Record<string, string> = {
        STATIC_HERMES_CACHE_DIR: cacheRoot
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
                  installWasiSdk
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
                  'configured wit-bindgen'
              )
            : await resolveWitBindgen({
                  toolchainRoot,
                  homeDirectory,
                  toolchainConfig,
                  environment: env,
                  platform,
                  installWitBindgen
              });
        environment.WIT_BINDGEN = bindgenPath;
    }

    if (includeWasmTools) {
        const version = toolchainConfig.tools['wasm-tools'];
        if (typeof version !== 'string') throw new Error('toolchain-versions.json must provide tools.wasm-tools');
        const configuredWasmTools = env.WASM_TOOLS;
        const wasmToolsPath = configuredWasmTools
            ? validateWasmTools(path.resolve(configuredWasmTools), version, 'configured wasm-tools')
            : await resolveWasmTools({ toolchainRoot, version, platform, arch, installWasmTools, fetchImpl });
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
            stdio: 'inherit'
        });
    }
}: StaticHermesBuildPreparationOptions): Promise<void> {
    Object.assign(env, await setupEnvironment({ workspaceRoot, env, includeWasmTools: true }));
    if (env.PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED !== '1') await prepare();
}

/** Reuse the cached WASI SDK or install and validate the configured version. */
async function resolveCachedWasiSdk({
    toolchainRoot,
    platform,
    arch,
    wasiSdkConfig,
    env,
    fetchImpl,
    installWasiSdk
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
    const destination = path.join(toolchainRoot, `wasi-sdk-${version}`);
    if (isWasiSdk(destination, platform)) return destination;
    const installed = await installWasiSdk({
        destination,
        platform,
        arch,
        repository,
        version,
        env,
        fetchImpl
    });
    return validateWasiSdk(path.resolve(installed), 'automatically installed WASI SDK', platform);
}

/** Reuse a cached or user-installed wit-bindgen, otherwise install its pinned version for the selected platform. */
async function resolveWitBindgen({
    toolchainRoot,
    homeDirectory,
    toolchainConfig,
    environment,
    platform,
    installWitBindgen
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
        platform
    );
    if (fs.existsSync(destination)) return validateWitBindgen(destination, witBindgenVersion, 'cached wit-bindgen');

    const userInstall = executablePath(path.join(homeDirectory, '.cargo', 'bin'), 'wit-bindgen', platform);
    if (fs.existsSync(userInstall)) {
        return validateWitBindgen(userInstall, witBindgenVersion, 'user-installed wit-bindgen');
    }

    const installed = await installWitBindgen({
        destination,
        version: witBindgenVersion,
        rustToolchainVersion,
        homeDirectory,
        environment,
        platform
    });
    return validateWitBindgen(path.resolve(installed), witBindgenVersion, 'automatically installed wit-bindgen');
}

/** Reuse a cached wasm-tools binary or install the pinned release archive. */
async function resolveWasmTools({
    toolchainRoot,
    version,
    platform,
    arch,
    installWasmTools,
    fetchImpl
}: {
    toolchainRoot: string;
    version: string;
    platform: NodeJS.Platform;
    arch: string;
    installWasmTools: NonNullable<HermesToolchainSetupOptions['installWasmTools']>;
    fetchImpl: typeof fetch;
}): Promise<string> {
    const binaryName = platform === 'win32' ? 'wasm-tools.exe' : 'wasm-tools';
    const executable = path.join(toolchainRoot, `wasm-tools-${version}`, 'bin', binaryName);
    if (fs.existsSync(executable)) return validateWasmTools(executable, version, 'cached wasm-tools');
    const installed = await installWasmTools({ destination: executable, version, platform, arch, fetchImpl });
    return validateWasmTools(path.resolve(installed), version, 'automatically installed wasm-tools');
}

/** Download, verify, extract, and cache the pinned wasm-tools release. */
async function installPinnedWasmTools({
    destination,
    version,
    platform,
    arch,
    fetchImpl = globalThis.fetch
}: WasmToolsInstallOptions): Promise<string> {
    const asset = selectWasmToolsAsset({ version, platform, arch });
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
    env,
    fetchImpl
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
            fetchImpl
        });
        const asset = selectWasiSdkAsset(release, { version, platform, arch });
        execFileSync(
            'curl',
            ['--fail', '--location', '--retry', '3', asset.browser_download_url, '--output', archive],
            { stdio: 'inherit' }
        );
        const actualSha256 = await sha256File(archive);
        const expectedSha256 = asset.digest.slice('sha256:'.length);
        if (actualSha256 !== expectedSha256) {
            throw new Error(`WASI SDK checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`);
        }

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
    platform: NodeJS.Platform = process.platform
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
    fetchImpl = globalThis.fetch
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
        'X-GitHub-Api-Version': '2022-11-28'
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetchImpl(url, { headers });
    if (!response.ok) {
        throw new Error(
            `Could not fetch WASI SDK ${version} release metadata: GitHub returned HTTP ${response.status}`
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
 * @throws {Error} If the release has no matching archive or its digest or URL is invalid.
 */
export function selectWasiSdkAsset(
    release: WasiSdkRelease,
    { version, platform, arch }: { version: string; platform: NodeJS.Platform; arch: string }
): WasiSdkReleaseAsset & { digest: string; browser_download_url: string } {
    const wasiOsByPlatform: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macos', win32: 'windows' };
    const wasiOs = wasiOsByPlatform[platform] ?? platform;
    const wasiArch = ({ x64: 'x86_64' } as Record<string, string>)[arch] ?? arch;
    const escapedVersion = escapeRegExp(version);
    const archivePattern = new RegExp(
        `^wasi-sdk-${escapedVersion}(?:\\.\\d+)?-${escapeRegExp(wasiArch)}-${escapeRegExp(wasiOs)}\\.tar\\.gz$`
    );
    const asset = release.assets?.find(({ name }) => archivePattern.test(name));
    if (!asset) {
        throw new Error(`no WASI SDK ${version} archive for ${platform}/${arch} in the configured GitHub release`);
    }
    const digest = asset.digest;
    if (!digest || !/^sha256:[0-9a-f]{64}$/i.test(digest)) {
        throw new Error(`WASI SDK archive ${asset.name} has no SHA-256 digest in GitHub release metadata`);
    }
    const browserDownloadUrl = asset.browser_download_url;
    if (typeof browserDownloadUrl !== 'string' || new URL(browserDownloadUrl).protocol !== 'https:') {
        throw new Error(`WASI SDK archive ${asset.name} has no valid HTTPS download URL`);
    }
    return { ...asset, digest, browser_download_url: browserDownloadUrl };
}

const WASM_TOOLS_RELEASE_ASSETS = {
    'darwin/arm64': ['aarch64-macos', '94c4fc9baeada6e793f0d4adeca537633b5d93e9dc6bf718be2f478f4afe0296'],
    'darwin/x64': ['x86_64-macos', '354a84ffeede30ba11f29bc72de76875a977cf43bf1c5bdc3e91e2313e8a854b'],
    'linux/arm64': ['aarch64-linux', '6f19389a69e21c7dbd2a4e7ae72f807dc999988b48782c706c4102bad3e44487'],
    'linux/x64': ['x86_64-linux', 'ad62b2176037e93e1348cb65d6212d128ca9f097b63d155569f25215818ff7b1'],
    'win32/arm64': ['aarch64-windows', '284a9010b7d8bf35270c7814f853c4d0e87b0c9a697d696b3273e5bf07565d23'],
    'win32/x64': ['x86_64-windows', '250c6ee7d8073865a5cb42e1077f4246c72516af9b09d41d8a2734985ae673fd']
} satisfies Record<string, readonly [string, string]>;
const WASM_TOOLS_ASSETS_BY_TARGET: Readonly<Record<string, readonly [string, string]>> = WASM_TOOLS_RELEASE_ASSETS;

/**
 * Return the pinned wasm-tools archive and checksum for a supported platform.
 *
 * @param target - Pinned release version, platform, and architecture.
 * @returns Archive filename, HTTPS download URL, and lowercase SHA-256 digest.
 * @throws {Error} If the version or platform/architecture pair has no pinned binary.
 */
export function selectWasmToolsAsset({
    version,
    platform,
    arch
}: {
    version: string;
    platform: NodeJS.Platform;
    arch: string;
}): { name: string; url: string; digest: string } {
    if (version !== '1.261.0') throw new Error(`no pinned wasm-tools release ${version}`);
    const asset = WASM_TOOLS_ASSETS_BY_TARGET[`${platform}/${arch}`];
    if (!asset) throw new Error(`no pinned wasm-tools ${version} binary for ${platform}/${arch}`);
    const [target, digest] = asset;
    const extension = platform === 'win32' ? '.zip' : '.tar.gz';
    const name = `wasm-tools-${version}-${target}${extension}`;
    return {
        name,
        url: `https://github.com/bytecodealliance/wasm-tools/releases/download/v${version}/${name}`,
        digest
    };
}

/** Validate the WASI SDK version and release repository configuration. */
function validateWasiSdkConfig(config: WasiSdkConfig): void {
    if (
        !config ||
        typeof config.version !== 'string' ||
        !/^\d+(?:\.\d+)?$/.test(config.version) ||
        typeof config.repository !== 'string'
    ) {
        throw new Error('wasi-sdk.lock.json must provide a numeric version and GitHub repository URL');
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

/** Install the pinned wit-bindgen CLI using the configured Rust toolchain. */
/** Install the pinned wit-bindgen release using rustup or an available cargo toolchain. */
async function installPinnedWitBindgen({
    destination,
    version,
    rustToolchainVersion,
    homeDirectory,
    environment,
    platform
}: WitBindgenInstallOptions): Promise<string> {
    const installRoot = path.dirname(path.dirname(destination));
    fs.mkdirSync(installRoot, { recursive: true });
    const rustup =
        findExecutable('rustup', environment, platform) ??
        executablePath(path.join(homeDirectory, '.cargo', 'bin'), 'rustup', platform);
    if (fs.existsSync(rustup)) {
        execFileSync(rustup, ['toolchain', 'install', rustToolchainVersion, '--profile', 'minimal'], {
            stdio: 'inherit'
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
                installRoot
            ],
            { stdio: 'inherit' }
        );
    } else {
        const cargo =
            findExecutable('cargo', environment, platform) ??
            executablePath(path.join(homeDirectory, '.cargo', 'bin'), 'cargo', platform);
        if (!fs.existsSync(cargo)) {
            throw new Error(
                `Static Hermes needs wit-bindgen ${version}; install Rust with rustup or set WIT_BINDGEN to an existing executable`
            );
        }
        execFileSync(cargo, ['install', 'wit-bindgen-cli', '--version', version, '--locked', '--root', installRoot], {
            stdio: 'inherit'
        });
    }

    return destination;
}

/** Check whether a WASI SDK directory contains its platform-specific target C compiler.
 *
 * @param directory - WASI SDK directory to inspect.
 * @param platform - Host platform used to resolve the compiler executable suffix.
 * @returns `true` when the target compiler exists.
 */
function isWasiSdk(directory: string, platform: NodeJS.Platform): boolean {
    return fs.existsSync(wasiSdkCompilerPath(directory, 'wasm32-wasip2-clang', platform));
}

/** Validate a WASI SDK directory and return its path.
 *
 * @param directory - SDK directory to inspect.
 * @param description - Source label included in validation errors.
 * @param platform - Host platform that determines the expected compiler executable suffix.
 * @returns The validated SDK directory.
 * @throws {Error} If the SDK target compiler is missing.
 */
function validateWasiSdk(directory: string, description: string, platform: NodeJS.Platform): string {
    if (!isWasiSdk(directory, platform)) {
        const compiler = path.basename(wasiSdkCompilerPath(directory, 'wasm32-wasip2-clang', platform));
        throw new Error(`${description} is missing bin/${compiler}: ${directory}`);
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
