import * as path from 'node:path';
import { type Capability, capabilitiesForInterface } from '@pumpkin-plugins/build/capabilities';
import { type AnalysisDiagnostic, analyzeModuleGraph, type ModuleGraph } from '@pumpkin-plugins/static-analysis';
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
import { mergeJsonStringArray, parseJsonObject, recordOf, setJsonValue } from './jsonc.ts';

/** Migrates dependencies and build settings while preserving JSONC comments and formatting. */
export async function migratePackageJson(source: string, projectRoot: string): Promise<TransformResult> {
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
    }

    const currentMigratedConfig = recordOf(parseJsonObject(migrated).value?.pumpkinPlugin);
    const configIsComplete =
        typeof currentMigratedConfig?.entry === 'string' && typeof currentMigratedConfig.output === 'string';
    if (currentMigratedConfig && !configIsComplete) {
        messages.push('Set both pumpkinPlugin.entry and pumpkinPlugin.output before running the new builder.');
    }

    if (currentMigratedConfig && typeof currentMigratedConfig.entry === 'string') {
        const inference = await inferWasiCapabilities(projectRoot, currentMigratedConfig.entry);
        messages.push(...inference.messages);
        if (inference.analyzed) {
            const wasi = currentMigratedConfig.wasi;
            if (wasi === undefined) {
                migrated = setJsonValue(migrated, ['pumpkinPlugin', 'wasi'], inference.capabilities, source);
            } else if (Array.isArray(wasi)) {
                migrated = mergeJsonStringArray(migrated, ['pumpkinPlugin', 'wasi'], inference.capabilities, source);
            } else {
                messages.push('pumpkinPlugin.wasi is not an array; its value was left unchanged.');
            }
        }
    } else if (!Object.hasOwn(configState.value ?? {}, 'pumpkinPlugin')) {
        messages.push(
            'Could not infer pumpkinPlugin.wasi because pumpkinPlugin.entry is missing; the existing wasi value was preserved.',
        );
    } else if (currentMigratedConfig) {
        messages.push(
            'Could not infer pumpkinPlugin.wasi because pumpkinPlugin.entry is missing or not a string; the existing wasi value was preserved.',
        );
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

/** The capabilities found in a production graph and any limits that need user review. */
interface WasiCapabilityInference {
    analyzed: boolean;
    capabilities: Capability[];
    messages: string[];
}

/** Analyzes only the configured production entry with the builder's external-module boundaries. */
async function inferWasiCapabilities(projectRoot: string, entry: string): Promise<WasiCapabilityInference> {
    const normalizedEntry = normalizePackagePath(entry);
    if (!normalizedEntry) {
        return {
            analyzed: false,
            capabilities: [],
            messages: [
                'Could not analyze pumpkinPlugin.entry because it is not a package-relative path; the existing wasi value was preserved.',
            ],
        };
    }

    let graph: ModuleGraph;
    try {
        graph = await analyzeModuleGraph({
            projectRoot,
            entryPoints: [normalizedEntry],
            resolution: {
                external: ['pumpkin:plugin/*', 'wasi:*'],
                platform: 'browser',
            },
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
            analyzed: false,
            capabilities: [],
            messages: [
                `Could not analyze pumpkinPlugin.entry ${JSON.stringify(entry)}: ${detail}; the existing wasi value was preserved.`,
            ],
        };
    }

    const root = graph.roots[0];
    if (root?.resolution.status !== 'resolved') {
        const messages = graph.diagnostics.map((diagnostic) => formatAnalysisDiagnostic(diagnostic, projectRoot));
        messages.push(
            `Could not resolve pumpkinPlugin.entry ${JSON.stringify(entry)}; WASI inference was skipped and the existing wasi value was preserved.`,
        );
        return { analyzed: false, capabilities: [], messages: [...new Set(messages)] };
    }

    const reachableFiles = new Set(graph.files.map(({ path: filePath }) => filePath));
    if (!reachableFiles.has(root.resolution.path)) {
        const messages = graph.diagnostics.map((diagnostic) => formatAnalysisDiagnostic(diagnostic, projectRoot));
        messages.push(
            `Could not read the configured production entry ${JSON.stringify(entry)}; WASI inference was skipped and the existing wasi value was preserved.`,
        );
        return { analyzed: false, capabilities: [], messages: [...new Set(messages)] };
    }

    const messages = graph.diagnostics.map((diagnostic) => formatAnalysisDiagnostic(diagnostic, projectRoot));
    const capabilities = new Set<Capability>();
    for (const edge of graph.edges) {
        if (!reachableFiles.has(edge.importer) || !edge.specifier?.startsWith('wasi:')) continue;
        const interfacePath = wasiInterfacePath(edge.specifier);
        if (!interfacePath) {
            messages.push(
                `Could not identify the WASI interface in ${JSON.stringify(edge.specifier)} from ${formatLocation(edge.importer, edge.location, projectRoot)}; other interfaces were still analyzed.`,
            );
            continue;
        }

        const matches = capabilitiesForInterface(interfacePath);
        if (matches.length === 1) {
            const capability = matches[0];
            if (capability) capabilities.add(capability);
        } else if (matches.length > 1) {
            messages.push(
                `WASI interface ${JSON.stringify(interfacePath)} is shared by ${matches.join(', ')}; no capability was inferred for it. Review pumpkinPlugin.wasi.`,
            );
        } else {
            messages.push(
                `WASI interface ${JSON.stringify(interfacePath)} has no builder capability mapping; review pumpkinPlugin.wasi.`,
            );
        }
    }

    return {
        analyzed: true,
        capabilities: [...capabilities].sort(),
        messages: [...new Set(messages)],
    };
}

/** Removes the WASI namespace and optional interface version from an import specifier. */
function wasiInterfacePath(specifier: string): string | undefined {
    const value = specifier.slice('wasi:'.length);
    const versionIndex = value.lastIndexOf('@');
    const interfacePath = versionIndex > 0 ? value.slice(0, versionIndex) : value;
    return interfacePath.includes('/') ? interfacePath : undefined;
}

/** Formats one analyzer diagnostic as a package-manifest review note. */
function formatAnalysisDiagnostic(diagnostic: AnalysisDiagnostic, projectRoot: string): string {
    const location = formatLocation(diagnostic.importer, diagnostic.location, projectRoot);
    const specifier = diagnostic.specifier === undefined ? '' : ` ${JSON.stringify(diagnostic.specifier)}`;
    switch (diagnostic.code) {
        case 'nonliteral-import':
            return `Could not infer capabilities from a computed ${diagnostic.form ?? 'import'}${specifier} at ${location}; other resolved WASI imports were still analyzed.`;
        case 'unresolved-import':
            return `Could not resolve${specifier} from ${location}; other resolved WASI imports were still analyzed.`;
        case 'unresolved-entry':
            return `Could not resolve the production entry${specifier} at ${location}: ${diagnostic.message}`;
        case 'unreadable-file':
            return `Could not read ${location}; the WASI analysis may be incomplete.`;
        case 'parse-error':
            return `Could not fully parse ${location}; the WASI analysis may be incomplete.`;
    }
}

/** Formats a project-relative source location for migration notes. */
function formatLocation(importer: string, location: { line: number; column: number }, projectRoot: string): string {
    const relativePath = path.relative(projectRoot, importer).split(path.sep).join('/');
    return `${relativePath || path.basename(importer)}:${location.line}:${location.column}`;
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
