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
    /** Resolves the builder version installed for a package directory. */
    resolveInstalledVersion?: (packageDirectory: string) => string | undefined;
    /** Writes previewed changes when true. */
    write?: boolean;
}

/**
 * Resolves the installed builder, fetches npm's latest release, and runs selected migrations.
 *
 * Each file gets the migrations for the builder installed in its nearest package directory.
 *
 * @throws {Error} If the builder installed for an input path or the latest release cannot be
 * determined, or npm's latest release predates an installed version.
 * @param paths - Files or directories selected by the caller.
 * @param options - Project, lookup, migration, and write configuration.
 * @returns Preview or write report from the shared codemod runner.
 */
export async function runUpdateBuild(
    paths: readonly string[] = [],
    options: UpdateBuildOptions = {},
): Promise<CodemodRunReport> {
    const projectRoot = path.resolve(options.cwd ?? process.cwd());
    const inputs = paths.length > 0 ? paths : ['.'];
    const installedVersion = installedVersionCache(options.resolveInstalledVersion);
    const inputVersions = inputs.map((input) => {
        const version = installedVersion(packageDirectoryOf(path.resolve(projectRoot, input)));
        if (!version) {
            throw new Error(
                `Cannot determine a valid installed ${packageName} version for ${quoteForTerminal(input)}; install the project dependencies first.`,
            );
        }
        return version;
    });

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
    for (const version of inputVersions) {
        if (semver.lt(validLatestVersion, version)) {
            throw new Error(
                `The latest ${packageName} version ${validLatestVersion} is older than the installed version ${version}; no files were changed.`,
            );
        }
    }

    const registry = options.migrations ?? buildMigrations;
    const selected = new Map<string, BuildMigration[]>();
    const migrationsFor = (filePath: string): BuildMigration[] => {
        const directory = packageDirectoryOf(filePath);
        let migrations = selected.get(directory);
        if (!migrations) {
            const version = installedVersion(directory);
            migrations = version ? selectBuildMigrations(version, validLatestVersion, registry) : [];
            selected.set(directory, migrations);
        }
        return migrations;
    };

    const run: UpdateRun = { latest: validLatestVersion, builderDeclared: false };
    const codemod = composeUpdateCodemod(
        run,
        registry.filter(({ introducedIn }) => semver.lte(introducedIn, validLatestVersion)),
        migrationsFor,
    );
    const report = await runCodemod(codemod, inputs, { cwd: projectRoot, write: options.write });
    if (!run.builderDeclared && run.firstManifest) {
        report.messages.push({
            relativePath: run.firstManifest,
            text: `No direct ${packageName} dependency was found; no dependency was added.`,
        });
    }
    return report;
}

/** State shared by the files of one update run. */
interface UpdateRun {
    /** Whether any scanned manifest declared the builder, directly or through an npm alias. */
    builderDeclared: boolean;
    /** First scanned manifest, which carries run-wide notes. */
    firstManifest?: string;
    latest: string;
}

/** Returns the nearest directory at or above `start` that has a package.json, or `start` itself. */
function packageDirectoryOf(start: string): string {
    let directory = fs.statSync(start, { throwIfNoEntry: false })?.isDirectory() ? start : path.dirname(start);
    const first = directory;
    while (!fs.existsSync(path.join(directory, 'package.json'))) {
        const parent = path.dirname(directory);
        if (parent === directory) return first;
        directory = parent;
    }
    return directory;
}

/** Resolves and validates the installed builder version once per package directory. */
function installedVersionCache(
    resolver: ((packageDirectory: string) => string | undefined) | undefined,
): (packageDirectory: string) => string | undefined {
    const versions = new Map<string, string | undefined>();
    return (packageDirectory) => {
        if (!versions.has(packageDirectory)) {
            const version = resolveInstalledBuilder(packageDirectory, resolver);
            versions.set(packageDirectory, semver.valid(version) ?? undefined);
        }
        return versions.get(packageDirectory);
    };
}

function resolveInstalledBuilder(
    packageDirectory: string,
    resolver: ((packageDirectory: string) => string | undefined) | undefined,
): string | undefined {
    if (resolver) {
        try {
            return resolver(packageDirectory);
        } catch {
            return undefined;
        }
    }

    try {
        const packageJsonPath = createRequire(path.join(packageDirectory, 'package.json')).resolve(
            `${packageName}/package.json`,
        );
        const packageManifest: unknown = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const version = recordOf(packageManifest)?.version;
        return typeof version === 'string' ? version : undefined;
    } catch {
        return undefined;
    }
}

function composeUpdateCodemod(
    run: UpdateRun,
    candidates: readonly BuildMigration[],
    migrationsFor: (filePath: string) => readonly BuildMigration[],
): CodemodDefinition {
    return {
        id: 'update-build',
        description: 'Update the build-tool version and apply its release migrations.',
        matchesFile: (relativePath) =>
            isManifest(relativePath) || candidates.some(({ codemod }) => codemod.matchesFile(relativePath)),
        transform: (context) => transformUpdateFile(context, run, migrationsFor(context.absolutePath)),
    };
}

function isManifest(relativePath: string): boolean {
    return relativePath === 'package.json' || relativePath.endsWith('/package.json');
}

async function transformUpdateFile(
    context: TransformContext,
    run: UpdateRun,
    migrations: readonly BuildMigration[],
): Promise<TransformResult> {
    let source = context.source;
    const messages: string[] = [];

    if (isManifest(context.relativePath)) {
        run.firstManifest ??= context.relativePath;
        const update = updateBuilderDeclarations(source, run.latest);
        if (update.declared) run.builderDeclared = true;
        source = update.source;
        messages.push(...(update.messages ?? []));
    }

    for (const { codemod } of migrations) {
        if (!codemod.matchesFile(context.relativePath)) continue;
        const result = await codemod.transform({ ...context, source });
        source = result.source;
        messages.push(...(result.messages ?? []));
    }

    return { source, ...(messages.length === 0 ? {} : { messages }) };
}

function updateBuilderDeclarations(source: string, latest: string): TransformResult & { declared: boolean } {
    const parsed = parseJsonObject(source);
    if (!parsed.value) return { source, declared: false, messages: [parsed.error ?? 'Skipped invalid package.json.'] };

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
                declarationsFound = true;
                messages.push(
                    `Cannot update npm alias ${field}.${quoteForTerminal(name)} for ${packageName}; update it to ${latest} manually.`,
                );
            }
        }
    }

    return { source: updatedSource, declared: declarationsFound, ...(messages.length === 0 ? {} : { messages }) };
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
