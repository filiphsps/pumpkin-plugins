/** Legacy npm package replaced by the standalone Pumpkin API package. */
export const LEGACY_API_PACKAGE = '@pumpkinmc/pumpkin-api-ts';

/** Public npm package that provides the Pumpkin plugin API. */
export const API_PACKAGE = '@pumpkin-plugins/pumpkin-api';

/** Public npm package that provides the Pumpkin plugin builder. */
export const BUILD_PACKAGE = '@pumpkin-plugins/build';

/** Legacy command whose positional paths become `pumpkinPlugin` settings. */
export const LEGACY_BUILD_COMMAND = 'pumpkin-plugin-build';

/** Command used by the standalone Pumpkin plugin builder. */
export const BUILD_COMMAND = 'pumpkin-plugins-build';

/** Range added for the API package; a test keeps it in line with the current release. */
export const API_VERSION_RANGE = '^0.1.0';

/** Range added for the builder package; a test keeps it in line with the current release. */
export const BUILD_VERSION_RANGE = '^0.1.5';

/** Generated declaration pattern emitted by the new builder. */
export const GENERATED_TYPES_GLOB = 'build/types/bindings/**/*.d.ts';

/** Dependency sections that can contain a package declaration. */
export const DEPENDENCY_SECTIONS = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
] as const;

/** Source extensions parsed by the migration's TypeScript AST pass. */
export const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);

/** Review note for a manifest that gets the new builder's default engine. */
export const ENGINE_NOTE =
    'Set pumpkinPlugin.engine to static-hermes, the new default runtime. The old builder ran QuickJS; set it to quickjs to keep the old runtime.';

/** Review notes attached to package manifest changes. */
export const MIGRATION_NOTES = [
    'Review inferred pumpkinPlugin.wasi capabilities and any static-analysis notes before building.',
    `Verify that tsconfig.json includes ${GENERATED_TYPES_GLOB} and does not exclude it through exclude or compilerOptions.outDir.`,
    "Update the lockfile by running the project's package manager install command.",
    'Review the migration guide for runtime behavior and license changes.',
];
