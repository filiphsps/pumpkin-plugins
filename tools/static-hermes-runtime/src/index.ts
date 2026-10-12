import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export { staticHermesImportsPlugin } from './esbuild-plugin.ts';

/** Hermes archive profile linked into a Static Hermes plugin component. */
export type StaticHermesRuntimeVariant = 'full' | 'lean';

/** Inputs for compiling a bundled plugin as a Static Hermes WASI component. */
export interface StaticHermesBuildOptions {
    bundle: string;
    witDir: string;
    output: string;
    developmentMode: boolean;
    runtimeVariant?: StaticHermesRuntimeVariant;
    wasiImports?: string[];
    wasiMethods?: string[];
    apiMethods?: string[];
}

/** Builds the component using the runtime package's pinned shim and external Hermes toolchain. */
export function buildStaticHermesComponent(options: StaticHermesBuildOptions): void {
    const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    execFileSync(
        process.execPath,
        [
            path.join(packageDir, 'bin/build-static-hermes.mjs'),
            '--bundle',
            options.bundle,
            '--wit',
            options.witDir,
            '--output',
            options.output,
            '--development-mode',
            options.developmentMode ? 'true' : 'false',
            '--wasi-imports',
            JSON.stringify(options.wasiImports ?? []),
            ...(options.wasiMethods === undefined ? [] : ['--wasi-methods', JSON.stringify(options.wasiMethods)]),
            ...(options.apiMethods === undefined ? [] : ['--api-methods', JSON.stringify(options.apiMethods)]),
            ...(options.runtimeVariant === undefined ? [] : ['--runtime-variant', options.runtimeVariant])
        ],
        { stdio: 'inherit' }
    );
}
