/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComponentBuildOptions } from './component/types.ts';
import type { HermesGcVariant } from './hermes/gc.ts';

export { staticHermesImportsPlugin } from './esbuild-plugin.ts';
export { buildHermesArtifacts, patchHermesSource, prepareHermes, prepareHermesSource } from './hermes/prepare.ts';
export { prepareStaticHermesBuild, setupHermesToolchainEnvironment } from './hermes/toolchain-environment.ts';

/** Hermes archive profile linked into a Static Hermes plugin component. */
export type StaticHermesRuntimeVariant = 'full' | 'lean';

/** Garbage collector linked into a Static Hermes plugin component. */
export type StaticHermesGcVariant = HermesGcVariant;

/** Inputs for compiling a bundled plugin as a Static Hermes WASI component. */
export interface StaticHermesBuildOptions extends Omit<ComponentBuildOptions, 'wasiImports' | 'wit'> {
    /** Suppress runtime stdout while preserving stderr for a caller's shared formatter. */
    quietOutput?: boolean;
    /** WASI interface specifiers requested by the plugin; defaults to no additional imports. */
    wasiImports?: string[];
    /** Path to the prepared WIT directory containing the plugin world. */
    witDir: string;
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
