import type { HermesGcVariant } from '../hermes/gc.ts';

/** Bundle, WIT, output, and feature selections for a Static Hermes component build. */
export interface ComponentBuildOptions {
    /** Pumpkin API operation identifiers for native dispatch; omission includes every declared operation. */
    apiMethods?: string[];
    /** Path to the bundled JavaScript source or an opt-in TypeScript bundle. */
    bundle: string;
    /** Whether to retain development symbols and Hermes source line information. */
    developmentMode: boolean;
    /** Event variants referenced by static registrations; omission includes every declared variant. */
    eventTypes?: string[];
    /** Garbage collector linked into the component; omitted to use Hades. */
    gcVariant?: HermesGcVariant;
    /** Destination path for the compiled component. */
    output: string;
    /** Parse the bundle as TypeScript with Hermes's unstable TypeScript parser. */
    parseTypeScript?: boolean;
    /** Hermes archive profile; omitted to use the configured default. */
    runtimeVariant?: 'full' | 'lean';
    /** WASI interface specifiers requested by the plugin. */
    wasiImports: string[];
    /** Optional WASI operation identifiers used to select native adapters. */
    wasiMethods?: string[];
    /** Path to the prepared WIT directory containing the plugin world. */
    wit: string;
    /** Consumer project directory used to find the nearest pnpm workspace root for runtime caches. */
    workspaceRoot?: string;
}

/** WIT world and operation selections that decide which adapters a component includes. */
export type ComponentWitSelection = Pick<
    ComponentBuildOptions,
    'apiMethods' | 'eventTypes' | 'wasiImports' | 'wasiMethods' | 'wit'
>;
