/** Bundle, WIT, output, and feature selections for a Static Hermes component build. */
export interface ComponentBuildOptions {
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
    /** Optional Pumpkin API operation identifiers used to select native dispatch. */
    apiMethods?: string[];
    /** Hermes archive profile; omitted to use the configured default. */
    runtimeVariant?: 'full' | 'lean';
}
