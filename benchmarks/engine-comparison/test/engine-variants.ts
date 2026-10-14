import * as path from 'node:path';

const staticHermesProfiles = [
    { id: 'full', supportsRuntimeSourceCompilation: true },
    { id: 'lean', supportsRuntimeSourceCompilation: false },
] as const;

type StaticHermesRuntime = (typeof staticHermesProfiles)[number]['id'];

/** Settings for one real-server engine comparison build. */
export interface EngineVariant {
    /** Expected Unicode property escape support for this build environment. */
    expectedUnicodePropertyEscapes: () => boolean;
    /** Stable identifier used for temporary package and result names. */
    id: string;
    /** Human-readable runtime, collector, and parser label. */
    label: string;
    /** Whether the build sends the bundle to Hermes's TypeScript parser. */
    parseTypeScript: boolean;
    /** Runtime selected by the plugin build configuration. */
    pluginEngine: 'quickjs' | 'static-hermes';
    /** Whether the runtime profile supports source compilation. */
    runtimeSourceCompilation: boolean;
    /** Static Hermes garbage collector, when applicable. */
    staticHermesGc?: 'hades' | 'malloc';
    /** Static Hermes runtime profile, when applicable. */
    staticHermesRuntime?: StaticHermesRuntime;
}

/** One benchmark job in the GitHub Actions matrix. */
export interface EngineBenchmarkMatrixEntry {
    /** Selects result artifact handling in the matrix workflow. */
    kind: 'benchmark';
    /** Stable engine or stack-guard identifier. */
    variant: string;
}

/** One Static Hermes stack-guard job in the GitHub Actions matrix. */
export interface EngineStackGuardMatrixEntry {
    /** Selects result artifact handling in the matrix workflow. */
    kind: 'stack-guard';
    /** Static Hermes runtime profile checked by this job. */
    runtime: StaticHermesRuntime;
    /** Stable engine or stack-guard identifier. */
    variant: string;
}

/** One benchmark or stack-guard job in the GitHub Actions matrix. */
export type EngineComparisonMatrixEntry = EngineBenchmarkMatrixEntry | EngineStackGuardMatrixEntry;

const staticHermesCollectors = [
    { id: 'hades', label: 'Hades' },
    { id: 'malloc', label: 'malloc' },
] as const;

const parserModes = [
    { id: 'js', label: 'JS parser', parseTypeScript: false },
    { id: 'ts', label: 'TS parser', parseTypeScript: true },
] as const;

/** Returns the stable Turbo output path assigned to an engine configuration. */
export function getEngineVariantBuildOutput(benchmarkDir: string, variantId: string): string {
    return path.join(benchmarkDir, 'build', 'engine-comparison', `${variantId}.wasm`);
}

/** Returns QuickJS and the Cartesian product of the Static Hermes matrix axes. */
export function createEngineVariants(): EngineVariant[] {
    const staticHermesVariants = staticHermesProfiles.flatMap((profile) =>
        staticHermesCollectors.flatMap((collector) =>
            parserModes.map((parser) => ({
                id: `static-hermes-${profile.id}-${collector.id}-${parser.id}`,
                label: `Static Hermes ${profile.id}, ${collector.label} GC, ${parser.label}`,
                pluginEngine: 'static-hermes' as const,
                staticHermesRuntime: profile.id,
                staticHermesGc: collector.id,
                parseTypeScript: parser.parseTypeScript,
                runtimeSourceCompilation: profile.supportsRuntimeSourceCompilation,
                expectedUnicodePropertyEscapes: () =>
                    process.env.STATIC_HERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES !== '0',
            })),
        ),
    );

    return [
        {
            id: 'quickjs',
            label: 'QuickJS',
            pluginEngine: 'quickjs',
            parseTypeScript: false,
            runtimeSourceCompilation: true,
            expectedUnicodePropertyEscapes: () => true,
        },
        ...staticHermesVariants,
    ];
}

/** Returns all benchmark and Static Hermes stack-guard jobs for CI. */
export function createEngineComparisonMatrix(): EngineComparisonMatrixEntry[] {
    const variants = createEngineVariants();
    const benchmarkJobs = variants.map(({ id }) => ({ kind: 'benchmark' as const, variant: id }));
    const runtimes = new Set(
        variants.flatMap(({ pluginEngine, staticHermesRuntime }) =>
            pluginEngine === 'static-hermes' && staticHermesRuntime ? [staticHermesRuntime] : [],
        ),
    );
    const stackGuardJobs = [...runtimes].map((runtime) => ({
        kind: 'stack-guard' as const,
        runtime,
        variant: `static-hermes-${runtime}-stack-guard`,
    }));

    return [...benchmarkJobs, ...stackGuardJobs];
}
