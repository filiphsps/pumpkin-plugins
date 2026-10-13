import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { HermesBuildOptions } from './build.ts';
import { buildHermes, hermesBuildFingerprint, requiredHermesArtifacts } from './build.ts';
import type { HermesProcessRunner } from './system.ts';

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
});

it('fingerprints Hermes source modules deterministically and invalidates when one changes', () => {
    const { options, packageRoot } = fixture();
    const sourceFile = path.join(packageRoot, 'src/hermes/build.ts');
    fs.writeFileSync(sourceFile, 'export const version = 1;\n');

    const original = hermesBuildFingerprint(options);

    expect(hermesBuildFingerprint(options)).toBe(original);
    fs.writeFileSync(sourceFile, 'export const version = 2;\n');
    expect(hermesBuildFingerprint(options)).not.toBe(original);
});

it('includes the compiled CLI source in the Hermes build fingerprint', () => {
    const { options, packageRoot } = fixture();
    const cliSource = path.join(packageRoot, 'src/cli.ts');
    fs.writeFileSync(cliSource, 'export const version = 1;\n');

    const original = hermesBuildFingerprint(options);
    fs.writeFileSync(cliSource, 'export const version = 2;\n');

    expect(hermesBuildFingerprint(options)).not.toBe(original);
});

it('builds missing archives, reuses a current cache, and rebuilds when settings change', async () => {
    const { options, calls } = fixture();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await buildHermes(options);
    expect(cmakeCalls(calls)).toHaveLength(4);
    expect(fs.existsSync(path.join(options.cacheRoot, 'prepared-build.json'))).toBe(true);

    await buildHermes(options);
    expect(cmakeCalls(calls)).toHaveLength(4);

    const environment = options.environment;
    if (!environment) throw new Error('Fixture is missing its build environment');
    environment.STATIC_HERMES_ENABLE_JSI_EXTENSIONS = '1';
    await buildHermes(options);
    expect(cmakeCalls(calls)).toHaveLength(8);
    expect(cmakeCalls(calls).some(({ args }) => args.includes('-DHERMES_ENABLE_CORE_EXTENSIONS=ON'))).toBe(true);
    expect(fs.existsSync(path.join(options.cacheRoot, 'prepare.lock'))).toBe(false);
});

it('releases the preparation lock when a CMake build fails', async () => {
    const { options, calls } = fixture({ failBuild: true });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(buildHermes(options)).rejects.toThrow('fixture CMake failure');

    expect(cmakeCalls(calls).some(({ args }) => args[0] === '--build')).toBe(true);
    expect(fs.existsSync(path.join(options.cacheRoot, 'prepare.lock'))).toBe(false);
    expect(fs.existsSync(path.join(options.cacheRoot, 'prepared-build.json'))).toBe(false);
});

it('builds and reuses Windows Hermes artifacts without probing MSVC as a GNU compiler', async () => {
    const { options, calls, outputCalls, setPlatform } = fixture();
    setPlatform('win32');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await buildHermes(options);

    const artifacts = requiredHermesArtifacts(options.hostBuild, options.wasiBuild, 'win32');
    expect(artifacts).toContain(path.join(options.hostBuild, 'bin/shermes.exe'));
    expect(artifacts).toContain(path.join(options.hostBuild, 'bin/hermesc.exe'));
    expect(fs.existsSync(path.join(options.hostBuild, 'bin/shermes.exe'))).toBe(true);
    expect(fs.existsSync(path.join(options.hostBuild, 'bin/hermesc.exe'))).toBe(true);
    expect(outputCalls.some(({ command }) => command === 'cc' || command === 'c++' || command === 'cl.exe')).toBe(
        false
    );

    await buildHermes(options);

    expect(cmakeCalls(calls)).toHaveLength(4);
    const fingerprintBeforeArtifactChange = hermesBuildFingerprint(options);
    fs.appendFileSync(path.join(options.hostBuild, 'bin/hermesc.exe'), 'updated artifact');
    expect(hermesBuildFingerprint(options)).not.toBe(fingerprintBeforeArtifactChange);

    await buildHermes(options);

    expect(cmakeCalls(calls)).toHaveLength(8);
    const compilerMetadata = path.join(options.hostBuild, 'CMakeFiles/4.4.4/CMakeCCompiler.cmake');
    const staleCompilerMetadata = path.join(options.hostBuild, 'CMakeFiles/3.28.0/CMakeCCompiler.cmake');
    const activeCompilerMetadata = fs.readFileSync(compilerMetadata, 'utf8');
    fs.rmSync(compilerMetadata);
    const fingerprintWithoutActiveMetadata = hermesBuildFingerprint(options);
    fs.writeFileSync(
        staleCompilerMetadata,
        'set(CMAKE_C_COMPILER_ID "MSVC")\nset(CMAKE_C_COMPILER_VERSION "19.99.99999")\n'
    );
    expect(hermesBuildFingerprint(options)).toBe(fingerprintWithoutActiveMetadata);

    fs.writeFileSync(compilerMetadata, activeCompilerMetadata);
    const fingerprintBeforeCompilerUpdate = hermesBuildFingerprint(options);
    expect(hermesBuildFingerprint(options)).toBe(fingerprintBeforeCompilerUpdate);
    fs.writeFileSync(
        compilerMetadata,
        'set(CMAKE_C_COMPILER_ID "MSVC")\nset(CMAKE_C_COMPILER_VERSION "19.45.35207")\n'
    );
    expect(hermesBuildFingerprint(options)).not.toBe(fingerprintBeforeCompilerUpdate);

    await buildHermes(options);

    expect(cmakeCalls(calls)).toHaveLength(12);
    expect(outputCalls.some(({ command }) => command === 'cl.exe')).toBe(false);
});

function fixture({ failBuild = false }: { failBuild?: boolean } = {}): {
    options: HermesBuildOptions;
    packageRoot: string;
    calls: Array<{ command: string; args: string[] }>;
    outputCalls: Array<{ command: string; args: string[] }>;
    setPlatform(platform: NodeJS.Platform): void;
} {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-build-unit-'));
    directories.push(root);
    const packageRoot = path.join(root, 'runtime');
    const cacheRoot = path.join(root, 'cache');
    const source = path.join(root, 'source');
    const hostBuild = path.join(root, 'build-host');
    const wasiBuild = path.join(root, 'build-wasip2');
    const wasiSdk = path.join(root, 'wasi-sdk');
    const toolchainFile = path.join(packageRoot, 'cmake/wasi-sdk-hermes-p2.cmake');
    const pinFile = path.join(packageRoot, 'hermes-source.lock.json');
    const patchFile = path.join(packageRoot, 'hermes-patches/0001-fixture.patch');

    for (const directory of [
        path.join(packageRoot, 'src/hermes'),
        path.join(packageRoot, 'bin'),
        path.join(packageRoot, 'cmake'),
        path.dirname(patchFile),
        source,
        path.join(wasiSdk, 'bin')
    ]) {
        fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(path.join(packageRoot, 'src/hermes/build.ts'), 'export {};\n');
    fs.writeFileSync(path.join(packageRoot, 'src/cli.ts'), '');
    fs.writeFileSync(path.join(packageRoot, 'src/hermes/toolchain-environment.ts'), '');
    fs.writeFileSync(path.join(packageRoot, 'toolchain-versions.json'), '{}\n');
    fs.writeFileSync(path.join(packageRoot, 'wasi-sdk.lock.json'), '{}\n');
    fs.writeFileSync(toolchainFile, 'toolchain fixture');
    fs.writeFileSync(pinFile, '{}\n');
    fs.writeFileSync(patchFile, 'patch fixture');

    const calls: Array<{ command: string; args: string[] }> = [];
    const outputCalls: Array<{ command: string; args: string[] }> = [];
    const process: HermesProcessRunner = {
        run(command, rawArgs) {
            const args = [...rawArgs];
            calls.push({ command, args });
            if (command === 'cmake' && args[0] === '-S') {
                const buildDirectory = args[3];
                if (!buildDirectory) throw new Error('CMake build directory is missing');
                fs.mkdirSync(buildDirectory, { recursive: true });
                const compiler =
                    buildDirectory === hostBuild
                        ? 'C:/BuildTools/VC/Tools/MSVC/bin/Hostx64/x64/cl.exe'
                        : 'C:/wasi-sdk/bin/wasm32-wasip2-clang.exe';
                const compilerCache =
                    optionsPlatform === 'win32'
                        ? `${[`CMAKE_C_COMPILER:FILEPATH=${compiler}`, `CMAKE_CXX_COMPILER:FILEPATH=${compiler}`].join(
                              '\n'
                          )}\n`
                        : '';
                fs.writeFileSync(path.join(buildDirectory, 'CMakeCache.txt'), compilerCache);
                if (optionsPlatform === 'win32') {
                    const compilerId = buildDirectory === hostBuild ? 'MSVC' : 'Clang';
                    const compilerVersion = buildDirectory === hostBuild ? '19.44.35207' : '20.1.0';
                    for (const [cmakeDirectory, recordedVersion] of [
                        ['3.28.0', '19.99.99999'],
                        ['4.4.4', compilerVersion]
                    ]) {
                        const cmakeFiles = path.join(buildDirectory, 'CMakeFiles', cmakeDirectory);
                        fs.mkdirSync(cmakeFiles, { recursive: true });
                        for (const compilerFile of ['CMakeCCompiler.cmake', 'CMakeCXXCompiler.cmake']) {
                            fs.writeFileSync(
                                path.join(cmakeFiles, compilerFile),
                                `set(${compilerFile === 'CMakeCCompiler.cmake' ? 'CMAKE_C' : 'CMAKE_CXX'}_COMPILER_ID "${compilerId}")\nset(${compilerFile === 'CMakeCCompiler.cmake' ? 'CMAKE_C' : 'CMAKE_CXX'}_COMPILER_VERSION "${recordedVersion}")\n`
                            );
                        }
                    }
                }
                return;
            }
            if (command !== 'cmake' || args[0] !== '--build') return;
            if (failBuild) throw new Error('fixture CMake failure');

            const buildDirectory = args[1];
            if (!buildDirectory) throw new Error('CMake build directory is missing');
            if (buildDirectory === hostBuild) {
                writeArtifact(path.join(hostBuild, 'ImportHostCompilers.cmake'));
                writeArtifact(path.join(hostBuild, 'bin', optionsPlatform === 'win32' ? 'shermes.exe' : 'shermes'));
                writeArtifact(path.join(hostBuild, 'bin', optionsPlatform === 'win32' ? 'hermesc.exe' : 'hermesc'));
            } else {
                writeArtifact(path.join(wasiBuild, 'lib/libhermesvm_a.a'));
                writeArtifact(path.join(wasiBuild, 'lib/libhermesvmlean_a.a'));
                writeArtifact(path.join(wasiBuild, 'jsi/libjsi.a'));
            }
        },
        output(command, args) {
            outputCalls.push({ command, args: [...args] });
            if (command === 'cmake') return 'cmake version 4.4.4';
            if (command === 'git') {
                if (args.includes('rev-parse')) return '820aa0d4b5fe5d3ed7900e1274211ef561081b3f';
                return '';
            }
            return `fixture ${path.basename(command)} version`;
        },
        buffer() {
            return Buffer.alloc(0);
        }
    };

    let optionsPlatform: NodeJS.Platform | undefined;
    const options: HermesBuildOptions = {
        packageRoot,
        cacheRoot,
        source,
        hostBuild,
        wasiBuild,
        wasiSdk,
        toolchainFile,
        pinFile,
        pin: {
            repository: 'https://github.com/facebook/hermes.git',
            branch: 'static_h',
            commit: '820aa0d4b5fe5d3ed7900e1274211ef561081b3f'
        },
        patches: [{ name: '0001-fixture.patch', filename: patchFile, sequence: 1, affectedPaths: ['src/a.cpp'] }],
        environment: {},
        process
    };
    return {
        packageRoot,
        calls,
        outputCalls,
        options,
        setPlatform(platform) {
            optionsPlatform = platform;
            options.platform = platform;
        }
    };
}

function writeArtifact(filename: string): void {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, 'fixture artifact');
}

function cmakeCalls(calls: Array<{ command: string; args: string[] }>): Array<{ command: string; args: string[] }> {
    return calls.filter(({ command }) => command === 'cmake');
}
