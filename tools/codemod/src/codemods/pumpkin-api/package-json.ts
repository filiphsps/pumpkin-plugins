import type { TransformResult } from '../../types.js';
import {
    API_PACKAGE,
    API_VERSION_RANGE,
    BUILD_COMMAND,
    BUILD_PACKAGE,
    BUILD_VERSION_RANGE,
    DEPENDENCY_SECTIONS,
    ENGINE_NOTE,
    LEGACY_API_PACKAGE,
    LEGACY_BUILD_COMMAND,
    MIGRATION_NOTES,
} from './constants.ts';
import { mergeJsonStringArray, parseJsonObject, recordOf, setJsonValue } from './jsonc.ts';
import { parseLegacyBuildCommand } from './legacy-build-command.ts';
import { inferWasiCapabilities } from './wasi-capabilities.ts';

type LegacyBuildPaths = NonNullable<ReturnType<typeof parseLegacyBuildCommand>>;

/** Migrates dependencies and build settings while preserving the manifest's formatting. */
export async function migratePackageJson(source: string, projectRoot: string): Promise<TransformResult> {
    const manifest = parseManifest(source);
    if (!manifest) {
        return {
            source,
            messages: ['Skipped package.json because it is not a JSON object; npm and pnpm cannot read it.'],
        };
    }

    const scripts = recordOf(manifest.scripts);
    const buildScript = typeof scripts?.build === 'string' ? scripts.build : undefined;
    const legacyApiUsed = dependencyObjects(manifest).some((section) => Object.hasOwn(section, LEGACY_API_PACKAGE));
    const legacyBuildUsed = buildScript?.includes(LEGACY_BUILD_COMMAND) === true;
    if (!legacyApiUsed && !legacyBuildUsed) return { source };

    const migration: ManifestMigration = { original: source, source, messages: [] };
    const inferredPaths = buildScript ? parseLegacyBuildCommand(buildScript) : undefined;
    migrateDependencies(migration, manifest);
    const configIsComplete = migrateBuilderConfig(migration, manifest, inferredPaths);
    await migrateWasi(migration, manifest, projectRoot);
    migrateScripts(migration, scripts, buildScript, inferredPaths, configIsComplete);

    if (migration.source !== source) migration.messages.push(...MIGRATION_NOTES);
    return { source: migration.source, messages: [...new Set(migration.messages)] };
}

/** Manifest text being migrated, with the original text that sets edit formatting. */
interface ManifestMigration {
    readonly messages: string[];
    readonly original: string;
    source: string;
}

/** Applies one property edit to the manifest being migrated. */
function setValue(migration: ManifestMigration, propertyPath: string[], value: unknown): void {
    migration.source = setJsonValue(migration.source, propertyPath, value, migration.original);
}

/** Reads `pumpkinPlugin` from the manifest as it stands after earlier edits. */
function builderConfig(migration: ManifestMigration): Record<string, unknown> | undefined {
    return recordOf(parseJsonObject(migration.source).value?.pumpkinPlugin);
}

/** Replaces the legacy API package and adds the new API and builder packages to dependencies. */
function migrateDependencies(migration: ManifestMigration, manifest: Record<string, unknown>): void {
    const sections = dependencyObjects(manifest);
    const apiVersion = existingDependencyVersion(sections, API_PACKAGE) ?? API_VERSION_RANGE;
    const buildVersion = existingDependencyVersion(sections, BUILD_PACKAGE) ?? BUILD_VERSION_RANGE;

    for (const sectionName of DEPENDENCY_SECTIONS) {
        if (Object.hasOwn(recordOf(manifest[sectionName]) ?? {}, LEGACY_API_PACKAGE)) {
            setValue(migration, [sectionName, LEGACY_API_PACKAGE], undefined);
        }
    }
    migration.source = ensureDependency(migration.source, API_PACKAGE, apiVersion, migration.original);
    migration.source = ensureDependency(migration.source, BUILD_PACKAGE, buildVersion, migration.original);
}

/**
 * Moves legacy build paths into `pumpkinPlugin` and adds the default engine.
 *
 * @returns Whether `pumpkinPlugin` now has both a string entry and a string output.
 */
function migrateBuilderConfig(
    migration: ManifestMigration,
    manifest: Record<string, unknown>,
    inferredPaths: LegacyBuildPaths | undefined,
): boolean {
    const { messages } = migration;
    const currentConfig = recordOf(manifest.pumpkinPlugin);

    if (Object.hasOwn(manifest, 'pumpkinPlugin') && !currentConfig) {
        messages.push('pumpkinPlugin is not an object; configure the new builder settings manually.');
        return false;
    }

    if (inferredPaths && currentConfig) {
        if (typeof currentConfig.entry === 'string' && currentConfig.entry !== inferredPaths.entry) {
            messages.push(
                'Existing pumpkinPlugin.entry differs from the path in scripts.build; confirm which entry is correct.',
            );
        }
        if (typeof currentConfig.output === 'string' && currentConfig.output !== inferredPaths.output) {
            messages.push(
                'Existing pumpkinPlugin.output differs from the path in scripts.build; confirm which output is correct.',
            );
        }
        if (typeof currentConfig.entry !== 'string') {
            if (Object.hasOwn(currentConfig, 'entry')) {
                messages.push(
                    'Existing pumpkinPlugin.entry is not a string; replaced it with the path from scripts.build.',
                );
            }
            setValue(migration, ['pumpkinPlugin', 'entry'], inferredPaths.entry);
        }
        if (!Object.hasOwn(currentConfig, 'output')) {
            setValue(migration, ['pumpkinPlugin', 'output'], inferredPaths.output);
        }
    } else if (inferredPaths) {
        setValue(migration, ['pumpkinPlugin'], { entry: inferredPaths.entry, output: inferredPaths.output });
    } else if (!currentConfig) {
        return false;
    }

    if (!Object.hasOwn(builderConfig(migration) ?? {}, 'engine')) {
        setValue(migration, ['pumpkinPlugin', 'engine'], 'static-hermes');
        messages.push(ENGINE_NOTE);
    }

    const config = builderConfig(migration);
    const complete = typeof config?.entry === 'string' && typeof config.output === 'string';
    if (!complete)
        messages.push('Set both pumpkinPlugin.entry and pumpkinPlugin.output before running the new builder.');
    return complete;
}

/** Merges WASI capabilities inferred from the configured production entry into `pumpkinPlugin.wasi`. */
async function migrateWasi(
    migration: ManifestMigration,
    manifest: Record<string, unknown>,
    projectRoot: string,
): Promise<void> {
    const { messages } = migration;
    const config = builderConfig(migration);
    if (typeof config?.entry !== 'string') {
        if (!Object.hasOwn(manifest, 'pumpkinPlugin')) {
            messages.push(
                'Could not infer pumpkinPlugin.wasi because pumpkinPlugin.entry is missing; the existing wasi value was preserved.',
            );
        } else if (config) {
            messages.push(
                'Could not infer pumpkinPlugin.wasi because pumpkinPlugin.entry is missing or not a string; the existing wasi value was preserved.',
            );
        }
        return;
    }

    const inference = await inferWasiCapabilities(projectRoot, config.entry);
    messages.push(...inference.messages);
    if (!inference.analyzed) return;
    if (config.wasi === undefined) {
        setValue(migration, ['pumpkinPlugin', 'wasi'], inference.capabilities);
    } else if (Array.isArray(config.wasi)) {
        migration.source = mergeJsonStringArray(
            migration.source,
            ['pumpkinPlugin', 'wasi'],
            inference.capabilities,
            migration.original,
        );
    } else {
        messages.push('pumpkinPlugin.wasi is not an array; its value was left unchanged.');
    }
}

/** Switches the build and typecheck scripts to the new builder when the config allows it. */
function migrateScripts(
    migration: ManifestMigration,
    scripts: Record<string, unknown> | undefined,
    buildScript: string | undefined,
    inferredPaths: LegacyBuildPaths | undefined,
    configIsComplete: boolean,
): void {
    const { messages } = migration;
    if (configIsComplete && (inferredPaths || buildScript === undefined)) {
        setValue(migration, ['scripts', 'build'], BUILD_COMMAND);
    } else if (buildScript !== undefined && buildScript.trim() !== BUILD_COMMAND) {
        messages.push(
            'Could not infer the entry and output paths from scripts.build; configure pumpkinPlugin.entry/output and update the build script manually.',
        );
    }

    const typecheck = scripts?.typecheck;
    if (configIsComplete && (typecheck === undefined || typecheck === 'tsc --noEmit')) {
        setValue(migration, ['scripts', 'typecheck'], `${BUILD_COMMAND} --types-only && tsc --noEmit`);
    } else if (typeof typecheck === 'string' && !typecheck.includes(`${BUILD_COMMAND} --types-only`)) {
        messages.push('Review the existing scripts.typecheck command and add the new builder --types-only step.');
    } else if (typecheck === undefined) {
        messages.push(
            'After setting pumpkinPlugin.entry/output, add the builder --types-only step to scripts.typecheck.',
        );
    }
}

/** Parses package.json strictly, because npm and pnpm reject comments and trailing commas in it. */
function parseManifest(source: string): Record<string, unknown> | undefined {
    try {
        return recordOf(JSON.parse(source));
    } catch {
        return undefined;
    }
}

/** Places a package in dependencies, moving an existing version from another section if present. */
function ensureDependency(
    source: string,
    packageName: string,
    defaultVersion: string,
    formattingSource: string,
): string {
    const parsed = parseJsonObject(source).value;
    if (!parsed) return source;
    const sections = dependencyObjects(parsed);
    const dependencies = recordOf(parsed.dependencies);
    const existingVersion = existingDependencyVersion(sections, packageName) ?? defaultVersion;
    let updated = source;
    for (const sectionName of DEPENDENCY_SECTIONS.slice(1)) {
        if (Object.hasOwn(recordOf(parsed[sectionName]) ?? {}, packageName)) {
            updated = setJsonValue(updated, [sectionName, packageName], undefined, formattingSource);
        }
    }
    if (!Object.hasOwn(dependencies ?? {}, packageName)) {
        updated = setJsonValue(updated, ['dependencies', packageName], existingVersion, formattingSource);
    }
    return updated;
}

/** Reads dependency section objects from a manifest. */
function dependencyObjects(manifest: Record<string, unknown>): Record<string, unknown>[] {
    return DEPENDENCY_SECTIONS.map((section) => recordOf(manifest[section])).filter(
        (section): section is Record<string, unknown> => section !== undefined,
    );
}

/** Returns the first string range declared for a dependency, checking sections in `DEPENDENCY_SECTIONS` order. */
function existingDependencyVersion(
    sections: readonly Record<string, unknown>[],
    packageName: string,
): string | undefined {
    for (const section of sections) {
        const value = section[packageName];
        if (typeof value === 'string') return value;
    }
    return undefined;
}
