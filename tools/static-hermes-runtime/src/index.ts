import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export { staticHermesImportsPlugin } from './esbuild-plugin.ts';
export { buildHermesArtifacts, patchHermesSource, prepareHermes, prepareHermesSource } from './hermes/prepare.ts';
export { prepareStaticHermesBuild, setupHermesToolchainEnvironment } from './hermes/toolchain-environment.ts';

/** Hermes archive profile linked into a Static Hermes plugin component. */
export type StaticHermesRuntimeVariant = 'full' | 'lean';

/** Inputs for compiling a bundled plugin as a Static Hermes WASI component. */
export interface StaticHermesBuildOptions {
    /** Consumer project root used for runtime toolchain caches. */
    workspaceRoot?: string;
    /** Path to the bundled JavaScript source. */
    bundle: string;
    /** Path to the prepared WIT directory containing the plugin world. */
    witDir: string;
    /** Destination path for the compiled component. */
    output: string;
    /** Whether to retain development symbols and Hermes source line information. */
    developmentMode: boolean;
    /** Suppress runtime stdout while preserving stderr for a caller's shared formatter. */
    quietOutput?: boolean;
    /** Hermes archive profile; defaults to the configured profile, usually `lean`. */
    runtimeVariant?: StaticHermesRuntimeVariant;
    /** WASI interface specifiers requested by the plugin; defaults to no additional imports. */
    wasiImports?: string[];
    /** WASI operation identifiers selected for native adapter generation. */
    wasiMethods?: string[];
    /** Pumpkin API operation identifiers selected for native dispatch generation. */
    apiMethods?: string[];
}

/**
 * Builds a plugin component using the runtime package's pinned shim and external Hermes toolchain.
 *
 * @param options - Bundle, WIT, output, development, and operation-selection inputs.
 * @throws {Error} If the Static Hermes CLI cannot prepare or build the requested component.
 */
export function buildStaticHermesComponent(options: StaticHermesBuildOptions): void {
    const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    execFileSync(
        process.execPath,
        [
            path.join(packageDir, 'dist/cli.js'),
            'component',
            'build',
            '--bundle',
            options.bundle,
            '--wit',
            options.witDir,
            '--output',
            options.output,
            ...(options.workspaceRoot === undefined ? [] : ['--workspace-root', options.workspaceRoot]),
            ...(options.developmentMode ? ['--development-mode'] : []),
            '--wasi-imports',
            JSON.stringify(options.wasiImports ?? []),
            ...(options.wasiMethods === undefined ? [] : ['--wasi-methods', JSON.stringify(options.wasiMethods)]),
            ...(options.apiMethods === undefined ? [] : ['--api-methods', JSON.stringify(options.apiMethods)]),
            ...(options.runtimeVariant === undefined ? [] : ['--runtime-variant', options.runtimeVariant])
        ],
        {
            stdio: options.quietOutput ? ['inherit', 'ignore', 'pipe'] : 'inherit',
            ...(options.quietOutput ? { maxBuffer: 16 * 1024 * 1024 } : {})
        }
    );
}
