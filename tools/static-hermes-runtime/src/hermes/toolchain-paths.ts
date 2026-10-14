import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Return an executable path with the suffix required by the selected host platform.
 *
 * @param directory - Directory containing the executable.
 * @param name - Executable name without a Windows suffix.
 * @param platform - Host platform; defaults to the current process platform.
 * @returns The joined executable path.
 */
export function executablePath(directory: string, name: string, platform: NodeJS.Platform = process.platform): string {
    return path.join(directory, platform === 'win32' && path.extname(name) === '' ? `${name}.exe` : name);
}

/**
 * Return the compiled Hermes bytecode compiler path for the host platform.
 *
 * @param hostBuild - Hermes host CMake build directory.
 * @param platform - Host platform; defaults to the current process platform.
 * @returns The `hermesc` executable path, including `.exe` on Windows.
 */
export function hermesHostCompilerPath(hostBuild: string, platform: NodeJS.Platform = process.platform): string {
    return executablePath(path.join(hostBuild, 'bin'), 'hermesc', platform);
}

/**
 * Resolve an explicitly configured executable path, adding `.exe` when Windows callers omit it.
 *
 * @param filename - Configured path to the executable.
 * @param platform - Host platform; defaults to the current process platform.
 * @returns The configured path with a Windows suffix when needed.
 */
export function configuredExecutablePath(filename: string, platform: NodeJS.Platform = process.platform): string {
    if (platform !== 'win32' || path.extname(filename) !== '') return filename;
    return `${filename}.exe`;
}

/**
 * Return the target compiler path in an installed WASI SDK.
 *
 * @param sdkRoot - Installed WASI SDK directory.
 * @param compiler - C or C++ `wasm32-wasip2` compiler name.
 * @param platform - Host platform; defaults to the current process platform.
 * @returns The compiler path inside the SDK.
 */
export function wasiSdkCompilerPath(
    sdkRoot: string,
    compiler: 'wasm32-wasip2-clang' | 'wasm32-wasip2-clang++',
    platform: NodeJS.Platform = process.platform,
): string {
    return executablePath(path.join(sdkRoot, 'bin'), compiler, platform);
}

/**
 * Find a Rust tool on PATH, accounting for the Windows executable suffix.
 *
 * @param name - Tool name such as `cargo` or `rustup`.
 * @param environment - Environment containing the PATH to search.
 * @param platform - Host platform; defaults to the current process platform.
 * @returns The matching executable path, or `undefined` when it is not on PATH.
 */
export function findExecutable(
    name: string,
    environment: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): string | undefined {
    const names = platform === 'win32' && path.extname(name) === '' ? [`${name}.exe`, name] : [name];
    for (const directory of (environment.PATH ?? '').split(path.delimiter)) {
        if (!directory) continue;
        for (const candidateName of names) {
            const candidate = path.join(directory, candidateName);
            if (fs.existsSync(candidate)) return candidate;
        }
    }
    return undefined;
}
