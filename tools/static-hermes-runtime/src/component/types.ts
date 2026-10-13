/** Bundle, WIT, output, and feature selections for a Static Hermes component build. */
export interface ComponentBuildOptions {
    /** Consumer project directory used to find the nearest pnpm workspace root for runtime caches. */
    workspaceRoot?: string;
    /** Path to the bundled JavaScript source. */
    bundle: string;
    /** Path to the prepared WIT directory containing the plugin world. */
    wit: string;
    /** Destination path for the compiled component. */
    output: string;
    /** Whether to retain development symbols and Hermes source line information. */
    developmentMode: boolean;
    /** WASI interface specifiers requested by the plugin. */
    wasiImports: string[];
    /** Optional WASI operation identifiers used to select native adapters. */
    wasiMethods?: string[];
    /** Pumpkin API operation identifiers for native dispatch; omission includes every declared operation. */
    apiMethods?: string[];
    /** Event variants referenced by static registrations; omission includes every declared variant. */
    eventTypes?: string[];
    /** Hermes archive profile; omitted to use the configured default. */
    runtimeVariant?: 'full' | 'lean';
}
