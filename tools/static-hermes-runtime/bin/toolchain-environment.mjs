import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createReadStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WASI_SDK_CONFIG = JSON.parse(fs.readFileSync(path.join(packageRoot, 'wasi-sdk.json'), 'utf8'));
const DEFAULT_TOOLCHAIN_CONFIG = JSON.parse(fs.readFileSync(path.join(packageRoot, 'toolchain-versions.json'), 'utf8'));

/**
 * Resolves or installs the external tools needed by a Static Hermes build.
 * @param options - Workspace paths and optional dependency installers.
 * @returns Environment variables for the Hermes preparation and component build.
 */
export async function setupHermesToolchainEnvironment({
    workspaceRoot,
    env = process.env,
    platform = process.platform,
    arch = process.arch,
    homeDirectory = os.homedir(),
    includeWitBindgen = true,
    wasiSdkConfig = DEFAULT_WASI_SDK_CONFIG,
    toolchainConfig = DEFAULT_TOOLCHAIN_CONFIG,
    fetchImpl = globalThis.fetch,
    installWasiSdk = installPinnedWasiSdk,
    installWitBindgen = installPinnedWitBindgen
}) {
    validateWasiSdkConfig(wasiSdkConfig);
    validateToolchainConfig(toolchainConfig);
    const cacheRoot = path.resolve(env.STATIC_HERMES_CACHE_DIR ?? path.join(workspaceRoot, '.cache/hermes'));
    const toolchainRoot = path.join(cacheRoot, 'toolchain');
    const configuredWasiSdk = env.STATIC_HERMES_WASI_SDK_PATH ?? env.WASI_SDK_PATH ?? env.WASI_SDK;
    const wasiSdkPath = configuredWasiSdk
        ? validateWasiSdk(path.resolve(configuredWasiSdk), 'configured WASI SDK')
        : await resolveCachedWasiSdk({
              toolchainRoot,
              platform,
              arch,
              wasiSdkConfig,
              env,
              fetchImpl,
              installWasiSdk
          });

    const environment = {
        STATIC_HERMES_CACHE_DIR: cacheRoot,
        STATIC_HERMES_WASI_SDK_PATH: wasiSdkPath
    };

    if (includeWitBindgen) {
        const configuredBindgen = env.WIT_BINDGEN;
        const bindgenPath = configuredBindgen
            ? validateWitBindgen(path.resolve(configuredBindgen), 'configured wit-bindgen')
            : await resolveWitBindgen({ toolchainRoot, homeDirectory, toolchainConfig, installWitBindgen });
        environment.WIT_BINDGEN = bindgenPath;
    }

    return environment;
}

/**
 * Sets up Hermes dependencies and prepares the pinned runtime before a component build.
 * @param options - Workspace environment and optional preparation hooks.
 */
export async function prepareStaticHermesBuild({
    workspaceRoot,
    env = process.env,
    setupEnvironment = setupHermesToolchainEnvironment,
    prepare = () => import('./prepare-hermes.mjs')
}) {
    Object.assign(env, await setupEnvironment({ workspaceRoot, env }));
    await prepare();
}

/** Reuse the cached WASI SDK or install and validate the configured version. */
async function resolveCachedWasiSdk({ toolchainRoot, platform, arch, wasiSdkConfig, env, fetchImpl, installWasiSdk }) {
    const { repository, version } = wasiSdkConfig;
    const destination = path.join(toolchainRoot, `wasi-sdk-${version}`);
    if (isWasiSdk(destination)) return destination;
    const installed = await installWasiSdk({
        destination,
        platform,
        arch,
        repository,
        version,
        env,
        fetchImpl
    });
    return validateWasiSdk(path.resolve(installed), 'automatically installed WASI SDK');
}

/** Reuse a cached or user-installed wit-bindgen, otherwise install its pinned version. */
async function resolveWitBindgen({ toolchainRoot, homeDirectory, toolchainConfig, installWitBindgen }) {
    const witBindgenVersion = toolchainConfig.tools['wit-bindgen'];
    const rustToolchainVersion = toolchainConfig.tools.rust;
    const destination = path.join(toolchainRoot, `wit-bindgen-${witBindgenVersion}`, 'bin', 'wit-bindgen');
    if (fs.existsSync(destination)) return destination;

    const userInstall = path.join(homeDirectory, '.cargo', 'bin', 'wit-bindgen');
    if (fs.existsSync(userInstall)) return userInstall;

    const installed = await installWitBindgen({
        destination,
        version: witBindgenVersion,
        rustToolchainVersion,
        homeDirectory
    });
    return validateWitBindgen(path.resolve(installed), 'automatically installed wit-bindgen');
}

/** Download, verify, and install the configured WASI SDK release. */
async function installPinnedWasiSdk({ destination, platform, arch, repository, version, env, fetchImpl }) {
    const parent = path.dirname(destination);
    fs.mkdirSync(parent, { recursive: true });
    const archive = `${destination}.${process.pid}.tar.gz`;
    const extraction = `${destination}.partial-${process.pid}`;
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

        fs.rmSync(extraction, { recursive: true, force: true });
        fs.mkdirSync(extraction, { recursive: true });
        execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', extraction], { stdio: 'inherit' });
        validateWasiSdk(extraction, 'downloaded WASI SDK');
        fs.rmSync(destination, { recursive: true, force: true });
        fs.renameSync(extraction, destination);
        return destination;
    } finally {
        fs.rmSync(archive, { force: true });
        fs.rmSync(extraction, { recursive: true, force: true });
    }
}

/** Fetches release metadata used to discover platform archives and their published digests. */
export async function fetchWasiSdkRelease({ repository, version, token, fetchImpl = globalThis.fetch }) {
    const repositoryUrl = new URL(repository);
    if (repositoryUrl.hostname !== 'github.com') {
        throw new Error(`WASI SDK release metadata must be hosted on GitHub: ${repository}`);
    }
    const repositoryPath = repositoryUrl.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    const url = `https://api.github.com/repos/${repositoryPath}/releases/tags/wasi-sdk-${version}`;
    const headers = {
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
    return response.json();
}

/** Finds a matching archive using the release asset list instead of a platform checksum table. */
export function selectWasiSdkAsset(release, { version, platform, arch }) {
    const wasiOs = { darwin: 'macos', win32: 'windows' }[platform] ?? platform;
    const wasiArch = { x64: 'x86_64' }[arch] ?? arch;
    const escapedVersion = escapeRegExp(version);
    const archivePattern = new RegExp(
        `^wasi-sdk-${escapedVersion}(?:\\.\\d+)?-${escapeRegExp(wasiArch)}-${escapeRegExp(wasiOs)}\\.tar\\.gz$`
    );
    const asset = release.assets?.find(({ name }) => archivePattern.test(name));
    if (!asset) {
        throw new Error(`no WASI SDK ${version} archive for ${platform}/${arch} in the configured GitHub release`);
    }
    if (!/^sha256:[0-9a-f]{64}$/i.test(asset.digest ?? '')) {
        throw new Error(`WASI SDK archive ${asset.name} has no SHA-256 digest in GitHub release metadata`);
    }
    if (typeof asset.browser_download_url !== 'string' || new URL(asset.browser_download_url).protocol !== 'https:') {
        throw new Error(`WASI SDK archive ${asset.name} has no valid HTTPS download URL`);
    }
    return asset;
}

/** Validate the WASI SDK version and release repository configuration. */
function validateWasiSdkConfig(config) {
    if (
        !config ||
        typeof config.version !== 'string' ||
        !/^\d+(?:\.\d+)?$/.test(config.version) ||
        typeof config.repository !== 'string'
    ) {
        throw new Error('wasi-sdk.json must provide a numeric version and GitHub repository URL');
    }
}

/** Validate the pinned wit-bindgen and Rust tool versions. */
function validateToolchainConfig(config) {
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
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Install the pinned wit-bindgen CLI using the configured Rust toolchain. */
async function installPinnedWitBindgen({ destination, version, rustToolchainVersion, homeDirectory }) {
    const installRoot = path.dirname(path.dirname(destination));
    fs.mkdirSync(installRoot, { recursive: true });
    const rustup = findExecutable('rustup') ?? path.join(homeDirectory, '.cargo', 'bin', 'rustup');
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
        const cargo = findExecutable('cargo') ?? path.join(homeDirectory, '.cargo', 'bin', 'cargo');
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

/** Find an executable by searching the current PATH. */
function findExecutable(name) {
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!directory) continue;
        const candidate = path.join(directory, name);
        if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
}

/** Check whether a directory contains the WASI SDK's target C compiler. */
function isWasiSdk(directory) {
    return fs.existsSync(path.join(directory, 'bin', 'wasm32-wasip2-clang'));
}

/** Validate a WASI SDK directory and return its path. */
function validateWasiSdk(directory, description) {
    if (!isWasiSdk(directory)) {
        throw new Error(`${description} is missing bin/wasm32-wasip2-clang: ${directory}`);
    }
    return directory;
}

/** Validate a wit-bindgen executable path and return it. */
function validateWitBindgen(executable, description) {
    if (!fs.existsSync(executable)) throw new Error(`${description} executable not found: ${executable}`);
    return executable;
}

/** Compute a file's SHA-256 digest by streaming its contents. */
async function sha256File(filename) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
}
