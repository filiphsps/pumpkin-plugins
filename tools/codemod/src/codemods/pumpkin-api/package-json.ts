import * as path from 'node:path';
import type { TransformResult } from '../../types.js';
import {
    API_PACKAGE,
    API_VERSION_RANGE,
    BUILD_COMMAND,
    BUILD_PACKAGE,
    DEPENDENCY_SECTIONS,
    LEGACY_API_PACKAGE,
    LEGACY_BUILD_COMMAND,
    MIGRATION_NOTES,
} from './constants.ts';
import { parseJsonObject, recordOf, setJsonValue } from './jsonc.ts';

/** Migrates dependencies and build settings while preserving JSONC comments and formatting. */
export function migratePackageJson(source: string): TransformResult {
    const original = parseJsonObject(source);
    if (!original.value) return { source, messages: [original.error ?? 'Skipped an invalid package.json.'] };

    const initialDependencies = dependencyObjects(original.value);
    const scripts = recordOf(original.value.scripts);
    const buildScript = typeof scripts?.build === 'string' ? scripts.build : undefined;
    const legacyApiUsed = initialDependencies.some((section) => Object.hasOwn(section, LEGACY_API_PACKAGE));
    const legacyBuildUsed = buildScript?.includes(LEGACY_BUILD_COMMAND) === true;
    if (!legacyApiUsed && !legacyBuildUsed) return { source };

    let migrated = source;
    const apiVersion = existingDependencyVersion(initialDependencies, API_PACKAGE) ?? API_VERSION_RANGE;
    const buildVersion = existingDependencyVersion(initialDependencies, BUILD_PACKAGE) ?? API_VERSION_RANGE;

    for (const sectionName of DEPENDENCY_SECTIONS) {
        if (Object.hasOwn(recordOf(original.value[sectionName]) ?? {}, LEGACY_API_PACKAGE)) {
            migrated = setJsonValue(migrated, [sectionName, LEGACY_API_PACKAGE], undefined, source);
        }
    }
    migrated = ensureDependency(migrated, API_PACKAGE, apiVersion, source);
    migrated = ensureDependency(migrated, BUILD_PACKAGE, buildVersion, source);

    const inferredPaths = buildScript ? parseLegacyBuildCommand(buildScript) : undefined;
    const unsupportedBuildScript = legacyBuildUsed && !inferredPaths;
    const configState = parseJsonObject(migrated);
    const currentConfig = recordOf(configState.value?.pumpkinPlugin);
    const configCanBeWritten = currentConfig !== undefined || inferredPaths !== undefined;
    const messages: string[] = [];

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
    }

    if (configState.value && Object.hasOwn(configState.value, 'pumpkinPlugin') && !currentConfig) {
        messages.push('pumpkinPlugin is not an object; configure the new builder settings manually.');
    } else if (!currentConfig && inferredPaths) {
        migrated = setJsonValue(
            migrated,
            ['pumpkinPlugin'],
            { entry: inferredPaths.entry, output: inferredPaths.output },
            source,
        );
    } else if (currentConfig && inferredPaths) {
        if (!Object.hasOwn(currentConfig, 'entry')) {
            migrated = setJsonValue(migrated, ['pumpkinPlugin', 'entry'], inferredPaths.entry, source);
        }
        if (!Object.hasOwn(currentConfig, 'output')) {
            migrated = setJsonValue(migrated, ['pumpkinPlugin', 'output'], inferredPaths.output, source);
        }
    }

    if (configCanBeWritten) {
        const config = recordOf(parseJsonObject(migrated).value?.pumpkinPlugin);
        if (config && !Object.hasOwn(config, 'engine')) {
            migrated = setJsonValue(migrated, ['pumpkinPlugin', 'engine'], 'static-hermes', source);
        }
        if (config && !Object.hasOwn(config, 'wasi')) {
            migrated = setJsonValue(migrated, ['pumpkinPlugin', 'wasi'], [], source);
        }
    }

    const currentMigratedConfig = recordOf(parseJsonObject(migrated).value?.pumpkinPlugin);
    const configIsComplete =
        typeof currentMigratedConfig?.entry === 'string' && typeof currentMigratedConfig.output === 'string';
    if (currentMigratedConfig && !configIsComplete) {
        messages.push('Set both pumpkinPlugin.entry and pumpkinPlugin.output before running the new builder.');
    }

    if (inferredPaths && configIsComplete) {
        migrated = setJsonValue(migrated, ['scripts', 'build'], BUILD_COMMAND, source);
    } else if (buildScript === undefined && configIsComplete) {
        migrated = setJsonValue(migrated, ['scripts', 'build'], BUILD_COMMAND, source);
    } else if (buildScript !== undefined && buildScript.trim() !== BUILD_COMMAND) {
        messages.push(
            'Could not infer the entry and output paths from scripts.build; configure pumpkinPlugin.entry/output and update the build script manually.',
        );
    }

    const typecheck = recordOf(parseJsonObject(migrated).value?.scripts)?.typecheck;
    if (typecheck === undefined && configIsComplete) {
        migrated = setJsonValue(
            migrated,
            ['scripts', 'typecheck'],
            `${BUILD_COMMAND} --types-only && tsc --noEmit`,
            source,
        );
    } else if (typecheck === 'tsc --noEmit' && configIsComplete) {
        migrated = setJsonValue(
            migrated,
            ['scripts', 'typecheck'],
            `${BUILD_COMMAND} --types-only && tsc --noEmit`,
            source,
        );
    } else if (typeof typecheck === 'string' && !typecheck.includes(`${BUILD_COMMAND} --types-only`)) {
        messages.push('Review the existing scripts.typecheck command and add the new builder --types-only step.');
    } else if (typecheck === undefined && !configIsComplete) {
        messages.push(
            'After setting pumpkinPlugin.entry/output, add the builder --types-only step to scripts.typecheck.',
        );
    }

    if (unsupportedBuildScript) {
        messages.push(
            'Could not infer the entry and output paths from scripts.build; configure pumpkinPlugin.entry/output and update the build script manually.',
        );
    }
    if (migrated !== source) messages.push(...MIGRATION_NOTES);
    return { source: migrated, messages: [...new Set(messages)] };
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

/** Chooses the first valid declared range for a dependency across standard package sections. */
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

/** Reads the two positional paths from a legacy builder command without evaluating shell syntax. */
function parseLegacyBuildCommand(command: string): { entry: string; output: string } | undefined {
    const tokens = shellWords(command);
    if (!tokens) return undefined;
    const commandIndex = tokens[0] === LEGACY_BUILD_COMMAND ? 0 : tokens[0] === 'pnpm' && tokens[1] === 'exec' ? 2 : -1;
    if (commandIndex < 0 || tokens[commandIndex] !== LEGACY_BUILD_COMMAND || tokens.length - commandIndex !== 3) {
        return undefined;
    }
    const [entry, output] = tokens.slice(commandIndex + 1);
    if (!entry || !output || entry.startsWith('-') || output.startsWith('-')) return undefined;
    const normalizedEntry = normalizePackagePath(entry);
    const normalizedOutput = normalizePackagePath(output);
    if (!normalizedEntry || !normalizedOutput || path.posix.extname(normalizedOutput).toLowerCase() !== '.wasm') {
        return undefined;
    }
    return { entry: normalizedEntry, output: normalizedOutput };
}

/** Normalizes a builder path only when it stays inside the package directory. */
function normalizePackagePath(value: string): string | undefined {
    const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
    if (
        value.length === 0 ||
        value.includes('\0') ||
        path.isAbsolute(value) ||
        path.win32.isAbsolute(value) ||
        path.win32.parse(value).root !== '' ||
        normalized === '.' ||
        normalized === '..' ||
        normalized.startsWith('../')
    ) {
        return undefined;
    }
    return normalized;
}

/** Splits simple quoted command arguments and rejects shell operators and expansions. */
function shellWords(command: string): string[] | undefined {
    const words: string[] = [];
    let word = '';
    let quote: '"' | "'" | undefined;
    let escaped = false;
    for (const character of command.trim()) {
        if (escaped) {
            word += character;
            escaped = false;
            continue;
        }
        if (quote) {
            if (character === quote) quote = undefined;
            else if (character === '$' && quote === '"') return undefined;
            else if (character === '\\' && quote === '"') escaped = true;
            else word += character;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        } else if (/\s/.test(character)) {
            if (word) words.push(word);
            word = '';
        } else if (';&|<>`$'.includes(character)) {
            return undefined;
        } else if (character === '\\') {
            escaped = true;
        } else {
            word += character;
        }
    }
    if (quote || escaped) return undefined;
    if (word) words.push(word);
    return words;
}
