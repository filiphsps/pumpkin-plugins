/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HermesGcVariant } from './hermes/gc.ts';

export { staticHermesImportsPlugin } from './esbuild-plugin.ts';
export { buildHermesArtifacts, patchHermesSource, prepareHermes, prepareHermesSource } from './hermes/prepare.ts';
export { prepareStaticHermesBuild, setupHermesToolchainEnvironment } from './hermes/toolchain-environment.ts';

/** Hermes archive profile linked into a Static Hermes plugin component. */
export type StaticHermesRuntimeVariant = 'full' | 'lean';

/** Garbage collector linked into a Static Hermes plugin component. */
export type StaticHermesGcVariant = HermesGcVariant;

/** Inputs for compiling a bundled plugin as a Static Hermes WASI component. */
export interface StaticHermesBuildOptions {
    /** Pumpkin API operation identifiers for native dispatch; omission includes every declared operation. */
    apiMethods?: string[];
    /** Path to the bundled JavaScript source or an opt-in TypeScript bundle. */
    bundle: string;
    /** Whether to retain development symbols and Hermes source line information. */
    developmentMode: boolean;
    /** Event variants referenced by static registrations; omission retains every event variant. */
    eventTypes?: string[];
    /** Garbage collector linked into the component; defaults to Hades. */
    gcVariant?: StaticHermesGcVariant;
    /** Destination path for the compiled component. */
    output: string;
    /** Parse the bundle as TypeScript with Hermes's unstable TypeScript parser. */
    parseTypeScript?: boolean;
    /** Suppress runtime stdout while preserving stderr for a caller's shared formatter. */
    quietOutput?: boolean;
    /** Hermes archive profile; defaults to the configured profile, usually `lean`. */
    runtimeVariant?: StaticHermesRuntimeVariant;
    /** WASI interface specifiers requested by the plugin; defaults to no additional imports. */
    wasiImports?: string[];
    /** WASI operation identifiers selected for native adapter generation. */
    wasiMethods?: string[];
    /** Path to the prepared WIT directory containing the plugin world. */
    witDir: string;
    /** Consumer project root used for runtime toolchain caches. */
    workspaceRoot?: string;
}

/**
 * Builds a plugin component using the runtime package's pinned shim and external Hermes toolchain.
 *
 * @param options - Bundle, WIT, output, development, and adapter-selection inputs.
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
            ...(options.parseTypeScript ? ['--parse-ts'] : []),
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
            ...(options.eventTypes === undefined ? [] : ['--event-types', JSON.stringify(options.eventTypes)]),
            ...(options.runtimeVariant === undefined ? [] : ['--runtime-variant', options.runtimeVariant]),
            ...(options.gcVariant === undefined ? [] : ['--gc-variant', options.gcVariant]),
        ],
        {
            stdio: options.quietOutput ? ['inherit', 'ignore', 'pipe'] : 'inherit',
            ...(options.quietOutput ? { maxBuffer: 16 * 1024 * 1024 } : {}),
        },
    );
}
