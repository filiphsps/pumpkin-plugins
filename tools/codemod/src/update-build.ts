import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { type LatestVersionOptions, type LatestVersionPackage, latestVersion } from '@badisi/latest-version';
import semver from 'semver';
import { type BuildMigration, buildMigrations, selectBuildMigrations } from './codemods/build-migrations.js';
import { parseJsonObject, recordOf, setJsonValue } from './codemods/pumpkin-api/jsonc.js';
import { runCodemod } from './runner.js';
import type { CodemodDefinition, CodemodRunReport, TransformContext, TransformResult } from './types.js';

const packageName = '@pumpkin-plugins/build';
const requestTimeout = 5_000;
const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

/** Registry lookup signature used by the explicit update workflow. */
export type UpdateBuildVersionLookup = (
    packageName: string,
    options?: LatestVersionOptions,
) => Promise<LatestVersionPackage>;

/** Dependencies that can be replaced to run the update workflow without network or installed packages. */
export interface UpdateBuildOptions {
    /** Working project directory; defaults to the current directory. */
    cwd?: string;
    /** Fresh npm lookup, injectable for tests. */
    lookup?: UpdateBuildVersionLookup;
    /** Release migration registry; injectable for interval and ordering tests. */
    migrations?: readonly BuildMigration[];
    /** Resolves the builder version installed in the project root. */
    resolveInstalledVersion?: (projectRoot: string) => string | undefined;
    /** Writes previewed changes when true. */
    write?: boolean;
}

/**
 * Resolves the installed builder, fetches npm's latest release, and runs selected migrations.
 *
 * @throws {Error} If the installed builder or latest release cannot be determined, or npm's latest
 * release predates the installed version.
 * @param paths - Files or directories selected by the caller.
 * @param options - Project, lookup, migration, and write configuration.
 * @returns Preview or write report from the shared codemod runner.
 */
export async function runUpdateBuild(
    paths: readonly string[] = [],
    options: UpdateBuildOptions = {},
): Promise<CodemodRunReport> {
    const projectRoot = path.resolve(options.cwd ?? process.cwd());
    const installedVersion = resolveInstalledBuilder(projectRoot, options.resolveInstalledVersion);
    const validInstalledVersion = semver.valid(installedVersion);
    if (!validInstalledVersion) {
        throw new Error(
            `Cannot determine a valid installed ${packageName} version; install the project dependencies first.`,
        );
    }

    let registryResult: LatestVersionPackage;
    try {
        registryResult = await (options.lookup ?? latestVersion)(packageName, {
            requestOptions: { timeout: requestTimeout },
        } satisfies LatestVersionOptions);
    } catch (error) {
        throw new Error(`Could not look up the latest ${packageName} release: ${errorMessage(error)}`, {
            cause: error,
        });
    }
    if (registryResult.error) {
        throw new Error(`Could not look up the latest ${packageName} release: ${registryResult.error.message}`);
    }

    const latest = registryResult.latest;
    const validLatestVersion = latest === undefined ? null : semver.valid(latest);
    if (!validLatestVersion) {
        throw new Error(`Could not determine a valid latest ${packageName} release from the npm registry.`);
    }
    if (semver.lt(validLatestVersion, validInstalledVersion)) {
        throw new Error(
            `The latest ${packageName} version ${validLatestVersion} is older than the installed version ${validInstalledVersion}; no files were changed.`,
        );
    }

    const migrations = selectBuildMigrations(
        validInstalledVersion,
        validLatestVersion,
        options.migrations ?? buildMigrations,
    );
    const codemod = composeUpdateCodemod(validLatestVersion, migrations);
    return runCodemod(codemod, paths.length > 0 ? paths : ['.'], {
        cwd: projectRoot,
        write: options.write,
    });
}

function resolveInstalledBuilder(
    projectRoot: string,
    resolver: ((projectRoot: string) => string | undefined) | undefined,
): string | undefined {
    if (resolver) {
        try {
            return resolver(projectRoot);
        } catch {
            return undefined;
        }
    }

    try {
        const packageJsonPath = createRequire(path.join(projectRoot, 'package.json')).resolve(
            `${packageName}/package.json`,
        );
        const packageManifest: unknown = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const version = recordOf(packageManifest)?.version;
        return typeof version === 'string' ? version : undefined;
    } catch {
        return undefined;
    }
}

function composeUpdateCodemod(latest: string, migrations: readonly BuildMigration[]): CodemodDefinition {
    return {
        id: 'update-build',
        description: 'Update the build-tool version and apply its release migrations.',
        matchesFile: (relativePath) =>
            relativePath === 'package.json' ||
            relativePath.endsWith('/package.json') ||
            migrations.some(({ codemod }) => codemod.matchesFile(relativePath)),
        transform: (context) => transformUpdateFile(context, latest, migrations),
    };
}

function transformUpdateFile(
    context: TransformContext,
    latest: string,
    migrations: readonly BuildMigration[],
): TransformResult {
    let source = context.source;
    const messages: string[] = [];

    if (context.relativePath === 'package.json' || context.relativePath.endsWith('/package.json')) {
        const update = updateBuilderDeclarations(source, latest);
        source = update.source;
        messages.push(...(update.messages ?? []));
    }

    for (const { codemod } of migrations) {
        if (!codemod.matchesFile(context.relativePath)) continue;
        const result = codemod.transform({ ...context, source });
        source = result.source;
        messages.push(...(result.messages ?? []));
    }

    return { source, ...(messages.length === 0 ? {} : { messages }) };
}

function updateBuilderDeclarations(source: string, latest: string): TransformResult {
    const parsed = parseJsonObject(source);
    if (!parsed.value) return { source, messages: [parsed.error ?? 'Skipped invalid package.json.'] };

    let updatedSource = source;
    let declarationsFound = false;
    const messages: string[] = [];
    for (const field of dependencyFields) {
        const dependencies = recordOf(parsed.value[field]);
        if (!dependencies) continue;

        for (const [name, specification] of Object.entries(dependencies)) {
            if (name === packageName) {
                declarationsFound = true;
                if (typeof specification !== 'string') {
                    messages.push(`Cannot update ${field}.${packageName}; update it to ${latest} manually.`);
                    continue;
                }
                const range = supportedRange(specification);
                if (!range) {
                    messages.push(
                        `Cannot update ${field}.${packageName} from unsupported specification ${quoteForTerminal(specification)}; update it to ${latest} manually.`,
                    );
                    continue;
                }
                const nextSpecification = `${range.prefix}${latest}`;
                if (nextSpecification !== specification) {
                    updatedSource = setJsonValue(updatedSource, [field, packageName], nextSpecification, source);
                }
            } else if (typeof specification === 'string' && /^npm:@pumpkin-plugins\/build(?:@|$)/.test(specification)) {
                messages.push(
                    `Cannot update npm alias ${field}.${quoteForTerminal(name)} for ${packageName}; update it to ${latest} manually.`,
                );
            }
        }
    }

    if (!declarationsFound && messages.length === 0) {
        messages.push(`No direct ${packageName} dependency was found; no dependency was added.`);
    }
    return { source: updatedSource, ...(messages.length === 0 ? {} : { messages }) };
}

function supportedRange(specification: string): { prefix: '^' | '~' | '' } | undefined {
    const match =
        /^([~^]?)(v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(
            specification,
        );
    return match && semver.validRange(specification) ? { prefix: match[1] as '^' | '~' | '' } : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function quoteForTerminal(value: string): string {
    return JSON.stringify(value).replace(
        /[\u007f-\u009f\u2028\u2029]/gu,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}
