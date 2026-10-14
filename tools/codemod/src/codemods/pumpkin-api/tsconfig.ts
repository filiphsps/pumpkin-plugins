import * as path from 'node:path';
import { applyEdits, modify } from 'jsonc-parser';
import * as ts from 'typescript';
import type { TransformResult } from '../../types.js';
import { GENERATED_TYPES_GLOB } from './constants.js';
import { formattingOf, parseJsonObject } from './jsonc.js';

/** Adds the generated declaration glob while preserving project roots and reporting exclusions.
 *
 * @param absolutePath - Config file path used to resolve inherited settings.
 */
export function migrateTsconfig(source: string, absolutePath: string): TransformResult {
    const parsed = parseJsonObject(source);
    if (!parsed.value) return { source, messages: [parsed.error ?? 'Skipped an invalid tsconfig.json.'] };

    const configPath = path.resolve(absolutePath);
    const inspection = Object.hasOwn(parsed.value, 'extends')
        ? inspectTsconfig(source, configPath)
        : inspectLocalTsconfig(parsed.value, configPath);
    if (inspection.error) {
        return {
            source,
            messages: [
                `Could not inspect tsconfig.json; verify that it includes ${GENERATED_TYPES_GLOB} and does not exclude those declarations.`,
            ],
        };
    }
    if (inspection.excludesGeneratedTypes) {
        return {
            source,
            messages: [
                `tsconfig.json excludes generated declarations under build/types/bindings via exclude or compilerOptions.outDir; adjust that setting and add ${GENERATED_TYPES_GLOB} manually.`,
            ],
        };
    }

    const ownInclude = parsed.value.include;
    let include: unknown = ownInclude;
    if (ownInclude === undefined) {
        const inheritedInclude = inspection.include;
        if (!inheritedInclude) {
            if (!inspection.hasFiles) return { source };
            include = [];
        } else if (
            !Array.isArray(inheritedInclude.patterns) ||
            inheritedInclude.patterns.some((pattern) => typeof pattern !== 'string')
        ) {
            return {
                source,
                messages: [
                    `tsconfig.json has an inherited include with non-string values; add ${GENERATED_TYPES_GLOB} manually.`,
                ],
            };
        } else {
            include = inheritedInclude.patterns;
        }
    }

    if (!Array.isArray(include) || include.some((item) => typeof item !== 'string')) {
        return {
            source,
            messages: [
                `tsconfig.json has an inherited or local include with non-string values; add ${GENERATED_TYPES_GLOB} manually.`,
            ],
        };
    }
    if (include.includes(GENERATED_TYPES_GLOB)) return { source };
    const updated = applyEdits(
        source,
        modify(source, ['include'], [...include, GENERATED_TYPES_GLOB], { formattingOptions: formattingOf(source) }),
    );
    return { source: updated };
}

interface EffectiveInclude {
    patterns: unknown;
}

interface TsconfigInspection {
    error?: true;
    excludesGeneratedTypes?: boolean;
    hasFiles?: boolean;
    include?: EffectiveInclude;
}

/** Reads effective config roots and generated-type exclusions with TypeScript's resolver. */
function inspectTsconfig(source: string, configPath: string): TsconfigInspection {
    const unrecoverableDiagnostics: ts.Diagnostic[] = [];
    const parsed = ts.getParsedCommandLineOfConfigFile(
        configPath,
        {},
        {
            ...ts.sys,
            readFile(fileName) {
                return path.resolve(fileName) === configPath ? source : ts.sys.readFile(fileName);
            },
            onUnRecoverableConfigFileDiagnostic(diagnostic) {
                unrecoverableDiagnostics.push(diagnostic);
            },
        },
    );

    if (
        !parsed ||
        unrecoverableDiagnostics.length > 0 ||
        parsed.errors.some((diagnostic) => diagnostic.code !== NO_INPUT_FILES_DIAGNOSTIC_CODE)
    ) {
        return { error: true };
    }

    const config = parsed.raw as { exclude?: unknown; files?: unknown; include?: unknown } | undefined;
    if (!config) return { error: true };
    return {
        excludesGeneratedTypes: excludesGeneratedTypes(config.exclude, parsed.options.outDir, config.files, configPath),
        hasFiles: Object.hasOwn(config, 'files'),
        ...(Object.hasOwn(config, 'include') ? { include: { patterns: config.include } } : {}),
    };
}

/** Reads local config roots without asking TypeScript to enumerate the project files. */
function inspectLocalTsconfig(config: Record<string, unknown>, configPath: string): TsconfigInspection {
    const compilerOptions = config.compilerOptions;
    const localOutDir =
        compilerOptions && typeof compilerOptions === 'object' && 'outDir' in compilerOptions
            ? compilerOptions.outDir
            : undefined;
    const outDir = typeof localOutDir === 'string' ? path.resolve(path.dirname(configPath), localOutDir) : undefined;

    return {
        excludesGeneratedTypes: excludesGeneratedTypes(config.exclude, outDir, config.files, configPath),
        hasFiles: Object.hasOwn(config, 'files'),
        ...(Object.hasOwn(config, 'include') ? { include: { patterns: config.include } } : {}),
    };
}

/** Returns true when effective exclusions cover the generated declaration directory. */
function excludesGeneratedTypes(
    exclude: unknown,
    outDir: string | undefined,
    files: unknown,
    configPath: string,
): boolean {
    const configDirectory = path.dirname(configPath);
    const generatedTypesDirectory = path.resolve(configDirectory, 'build/types/bindings');
    if (hasExplicitGeneratedDeclaration(files, configDirectory, generatedTypesDirectory)) return false;
    if (outDir && isPathWithin(generatedTypesDirectory, outDir)) return true;
    if (!Array.isArray(exclude)) return false;

    const candidates = [path.join(generatedTypesDirectory, '__generated__.d.ts')];
    for (
        let directory = generatedTypesDirectory;
        isPathWithin(directory, configDirectory);
        directory = path.dirname(directory)
    ) {
        candidates.push(directory);
        if (directory === configDirectory) break;
    }

    return exclude.some((pattern) => {
        if (typeof pattern !== 'string') return false;
        const absolutePattern = path.resolve(configDirectory, pattern).split(path.sep).join('/');
        const matches = globMatcher(absolutePattern);
        return (
            candidates.some((candidate) => matches.test(candidate.split(path.sep).join('/'))) ||
            (absolutePattern.endsWith('.d.ts') && isPathWithin(absolutePattern, generatedTypesDirectory))
        );
    });
}

/** Returns true when `files` already roots a declaration under the generated directory. */
function hasExplicitGeneratedDeclaration(
    files: unknown,
    configDirectory: string,
    generatedTypesDirectory: string,
): boolean {
    if (!Array.isArray(files)) return false;
    return files.some(
        (file) =>
            typeof file === 'string' &&
            file.endsWith('.d.ts') &&
            isPathWithin(path.resolve(configDirectory, file), generatedTypesDirectory),
    );
}

/** Converts TypeScript's `*`, `?`, and `**` path wildcards to a matcher. */
function globMatcher(pattern: string): RegExp {
    let expression = '^';
    for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index];
        if (character === '*' && pattern[index + 1] === '*') {
            index += 1;
            if (pattern[index + 1] === '/') {
                expression += '(?:.*/)?';
                index += 1;
            } else {
                expression += '.*';
            }
        } else if (character === '*') {
            expression += '[^/]*';
        } else if (character === '?') {
            expression += '[^/]';
        } else {
            expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`${expression}$`, ts.sys.useCaseSensitiveFileNames ? '' : 'i');
}

/** Tests whether a path is equal to or nested below a directory. */
function isPathWithin(candidate: string, directory: string): boolean {
    const relative = path.relative(directory, candidate);
    return (
        relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    );
}

/** TypeScript emits this when a valid config matches no files; it does not affect include resolution. */
const NO_INPUT_FILES_DIAGNOSTIC_CODE = 18003;
