/** Settings for one real-server engine comparison build. */
export interface EngineVariant {
    /** Stable identifier used for temporary package and result names. */
    id: string;
    /** Human-readable runtime, collector, and parser label. */
    label: string;
    /** Runtime selected by the plugin build configuration. */
    pluginEngine: 'quickjs' | 'static-hermes';
    /** Static Hermes runtime profile, when applicable. */
    staticHermesRuntime?: 'full' | 'lean';
    /** Static Hermes garbage collector, when applicable. */
    staticHermesGc?: 'hades' | 'malloc';
    /** Whether the build sends the bundle to Hermes's TypeScript parser. */
    parseTypeScript: boolean;
    /** Whether the runtime profile supports source compilation. */
    runtimeSourceCompilation: boolean;
    /** Expected Unicode property escape support for this build environment. */
    expectedUnicodePropertyEscapes: () => boolean;
}

const staticHermesProfiles = [
    { id: 'full', supportsRuntimeSourceCompilation: true },
    { id: 'lean', supportsRuntimeSourceCompilation: false }
] as const;

const staticHermesCollectors = [
    { id: 'hades', label: 'Hades' },
    { id: 'malloc', label: 'malloc' }
] as const;

const parserModes = [
    { id: 'js', label: 'JS parser', parseTypeScript: false },
    { id: 'ts', label: 'TS parser', parseTypeScript: true }
] as const;

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
                    process.env.STATIC_HERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES !== '0'
            }))
        )
    );

    return [
        {
            id: 'quickjs',
            label: 'QuickJS',
            pluginEngine: 'quickjs',
            parseTypeScript: false,
            runtimeSourceCompilation: true,
            expectedUnicodePropertyEscapes: () => true
        },
        ...staticHermesVariants
    ];
}
