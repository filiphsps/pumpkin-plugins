import * as path from 'node:path';

/** Garbage collectors supported by the Static Hermes WASI runtime. */
export type HermesGcVariant = 'hades' | 'malloc';

/** Resolve a collector's isolated WASI build directory from the configured cache paths. */
export function hermesWasiBuildDirectory(
    cacheRoot: string,
    environment: NodeJS.ProcessEnv,
    gcVariant: HermesGcVariant
): string {
    const configured = path.resolve(environment.STATIC_HERMES_WASI_BUILD_DIR ?? path.join(cacheRoot, 'build-wasip2'));
    return gcVariant === 'hades' ? configured : `${configured}-malloc`;
}
