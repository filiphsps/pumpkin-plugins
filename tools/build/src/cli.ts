#!/usr/bin/env node
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from '@commander-js/extra-typings';
import { ensurePumpkinWit } from '@pumpkin-plugins/pumpkin-api/wit';
import { wasiInterfaces } from '@pumpkin-plugins/wasi-capabilities';
import { CommanderError } from 'commander';
import { bundlePlugin } from './bundle.ts';
import { BuildError } from './errors.ts';
import { printBuildOutput } from './output.ts';
import { readPluginConfig, requireBuildFields } from './plugin-config.ts';
import { cacheDir } from './repo.ts';
import { generateTypes } from './types.ts';
import { startBuildUpdateCheck } from './update-check.ts';
import { ensureWasiWit, readLock } from './wasi-wit.ts';
import { withFileLock } from './wasi-wit-lock.ts';
import { prepareWit, publishWitSnapshot } from './wit.ts';

/**
 * Builds the plugin in `pluginDir`, or with `--types-only` just its type declarations.
 * @param args - Command line arguments.
 * @param pluginDir - The package to build.
 */
export async function run(args: string[], pluginDir: string): Promise<void> {
    const command = new Command()
        .name('pumpkin-plugins-build')
        .description('Build the Pumpkin plugin in the current directory.')
        .version((createRequire(import.meta.url)('../package.json') as { version: string }).version)
        .option('--types-only', 'Generate guest declarations without building a component')
        .option('--parse-ts', 'Use Hermes TypeScript parsing for the component bundle')
        .option('--no-update-notifier', 'Skip the npm update check')
        .option('--no-update-cache', 'Skip the npm update check cache')
        .configureOutput({ outputError: () => {} })
        .exitOverride();
    try {
        command.parse(args, { from: 'user' });
    } catch (error) {
        if (!(error instanceof CommanderError)) throw error;
        if (error.exitCode === 0) return;
        throw new BuildError(error.message.replace(/^error: /, ''));
    }
    const { typesOnly, parseTs } = command.opts();

    const config = readPluginConfig(pluginDir);
    if (parseTs && config.engine !== 'static-hermes') {
        throw new BuildError('--parse-ts requires Static Hermes');
    }
    const buildFields = typesOnly ? undefined : requireBuildFields(config);
    const buildDir = path.join(pluginDir, 'build');
    const apiWit = resolveApiWit(pluginDir);
    const interfaces = wasiInterfaces(config.wasi);
    const wasiLock = readLock();
    const wasiWit =
        interfaces.length > 0 ? await ensureWasiWit({ cacheDir: cacheDir(pluginDir), lock: wasiLock }) : undefined;
    const wasiFiles = Object.keys(wasiLock.files);

    // Keep types and builds isolated; only generated declarations stay under build/types.
    if (!buildFields) {
        let witDir = apiWit;
        let temporaryWitRoot: string | undefined;
        try {
            if (interfaces.length > 0) {
                temporaryWitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-plugin-types-'));
                witDir = prepareWit({
                    apiWit,
                    interfaces,
                    wasiWit,
                    wasiFiles,
                    target: path.join(temporaryWitRoot, 'wit'),
                });
            }
            generateTypes(witDir, path.join(buildDir, 'types', 'bindings'));
        } finally {
            if (temporaryWitRoot !== undefined) fs.rmSync(temporaryWitRoot, { recursive: true, force: true });
        }
        return;
    }

    const { entry, output } = buildFields;
    const temporaryWitRoot =
        interfaces.length > 0 ? fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-plugin-build-wit-')) : undefined;
    try {
        const witDir = prepareWit({
            apiWit,
            interfaces,
            wasiWit,
            wasiFiles,
            target: temporaryWitRoot === undefined ? path.join(buildDir, 'wit') : path.join(temporaryWitRoot, 'wit'),
        });
        const witSnapshot = path.join(buildDir, 'wit');
        await withFileLock(path.join(buildDir, '.wit-publish.lock'), () => {
            if (temporaryWitRoot !== undefined) publishWitSnapshot(witDir, witSnapshot);
            else fs.rmSync(witSnapshot, { recursive: true, force: true });
        });

        const { engine } = config;
        const staticHermesRuntime =
            config.engine === 'static-hermes'
                ? process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE === '0'
                    ? 'full'
                    : (config.staticHermesRuntime ?? 'lean')
                : undefined;
        const staticHermesGc = config.engine === 'static-hermes' ? config.staticHermesGc : undefined;
        printBuildOutput({
            type: 'bundle',
            entry,
            engine,
            ...(staticHermesRuntime === undefined ? {} : { runtimeVariant: staticHermesRuntime }),
            ...(staticHermesGc === undefined ? {} : { gcVariant: staticHermesGc }),
            ...(parseTs ? { parseTypeScript: true } : {}),
        });
        const size = await bundlePlugin({
            projectRoot: pluginDir,
            entry: path.resolve(pluginDir, entry),
            output: path.resolve(pluginDir, output),
            witDir,
            version: config.version,
            engine,
            quietRuntimeOutput: process.env.PUMPKIN_PLUGINS_VERBOSE_BUILD !== '1',
            onOutput: printBuildOutput,
            ...(staticHermesRuntime === undefined ? {} : { staticHermesRuntime }),
            ...(staticHermesGc === undefined ? {} : { staticHermesGc }),
            ...(parseTs ? { parseTypeScript: true } : {}),
            developmentMode: process.env.PUMPKIN_DEV_MODE === '1',
        });
        printBuildOutput({ type: 'built', output, sizeBytes: size });
    } finally {
        if (temporaryWitRoot !== undefined) fs.rmSync(temporaryWitRoot, { recursive: true, force: true });
    }
}

/** Dependencies for the executable CLI boundary. */
export interface ExecuteCliOptions {
    /** Environment used to decide whether to check for an update. */
    environment?: NodeJS.ProcessEnv;
    /** Whether standard output is an interactive terminal. */
    isTTY?: boolean;
    /** Starts an update lookup; injectable to test CLI dispatch without network access. */
    startUpdateCheck?: typeof startBuildUpdateCheck;
}

/** Starts an optional update lookup, runs the build while it is pending, then waits for the lookup to finish. */
export async function executeCli(args: string[], pluginDir: string, options: ExecuteCliOptions = {}): Promise<void> {
    const startUpdateCheck = options.startUpdateCheck ?? startBuildUpdateCheck;
    const environment = options.environment ?? process.env;
    const isTTY = options.isTTY ?? process.stdout.isTTY === true;
    const update = startUpdateCheck(args, { environment, isTTY }).catch(() => undefined);
    await main(args, pluginDir);
    await update;
}

/**
 * Resolves the Pumpkin API package and fetches its pinned WIT into the consumer cache.
 *
 * @remarks Only API packages the plugin declares are tried, so a copy hoisted from a tool dependency is never
 * used. A directly declared canonical dependency is tried before declared aliases.
 * @param pluginDir - Root directory of the consuming plugin project.
 * @param resolvePackageJson - Resolver for a requested API package manifest, injectable for isolated callers.
 * @returns The cached WIT directory selected by the API package's `wit.lock.json`.
 * @throws {BuildError} If the plugin declares no API package, or the package, pin, Git checkout, or WIT files cannot
 * be resolved.
 */
export function resolveApiWit(
    pluginDir: string,
    resolvePackageJson: (pluginDir: string, packageSpecifier: string) => string = (root, packageSpecifier) =>
        createRequire(path.join(root, 'package.json')).resolve(packageSpecifier),
): string {
    let packageJson: string;
    try {
        const { aliases, hasCanonicalDependency } = apiPackageSpecifiers(pluginDir);
        const packageSpecifiers = hasCanonicalDependency
            ? ['@pumpkin-plugins/pumpkin-api/package.json', ...aliases]
            : aliases;
        let resolvedPackageJson: string | undefined;
        for (const packageSpecifier of packageSpecifiers) {
            try {
                resolvedPackageJson = resolvePackageJson(pluginDir, packageSpecifier);
                break;
            } catch {
                // Try the next declared API package.
            }
        }
        if (resolvedPackageJson === undefined) throw new Error('API package manifest was not resolved');
        packageJson = resolvedPackageJson;
    } catch {
        throw new BuildError(
            'cannot resolve @pumpkin-plugins/pumpkin-api or its declared package alias from this plugin; add it to the plugin dependencies and run your package manager install',
        );
    }

    const apiRoot = path.dirname(packageJson);
    const lockFile = path.join(apiRoot, 'wit.lock.json');
    try {
        return ensurePumpkinWit({ lockFile, cacheRoot: cacheDir(pluginDir) });
    } catch (error) {
        throw new BuildError(
            `could not resolve pinned WIT for @pumpkin-plugins/pumpkin-api: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * Finds declared canonical and alias dependencies on the Pumpkin API package.
 * @param pluginDir - Root directory of the consuming plugin project.
 * @returns The declared aliases and whether the canonical package is a direct dependency.
 */
function apiPackageSpecifiers(pluginDir: string): { aliases: string[]; hasCanonicalDependency: boolean } {
    let packageManifest: unknown;
    try {
        packageManifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
    } catch {
        return { aliases: [], hasCanonicalDependency: false };
    }
    if (typeof packageManifest !== 'object' || packageManifest === null || Array.isArray(packageManifest)) {
        return { aliases: [], hasCanonicalDependency: false };
    }

    const dependencies = packageManifest as Record<string, unknown>;
    const aliases = new Set<string>();
    let hasCanonicalDependency = false;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        const declarations = dependencies[field];
        if (typeof declarations !== 'object' || declarations === null || Array.isArray(declarations)) continue;

        for (const [packageName, specification] of Object.entries(declarations)) {
            if (packageName === '@pumpkin-plugins/pumpkin-api') {
                hasCanonicalDependency = true;
                continue;
            }
            if (typeof specification === 'string' && /^npm:@pumpkin-plugins\/pumpkin-api(?:@|$)/.test(specification)) {
                aliases.add(`${packageName}/package.json`);
            }
        }
    }
    return { aliases: [...aliases], hasCanonicalDependency };
}

/**
 * Runs the build and reports `BuildError` failures through the CLI output and exit code.
 * @param args - Command line arguments.
 * @param pluginDir - The package to build.
 */
export async function main(args: string[], pluginDir: string): Promise<void> {
    try {
        await run(args, pluginDir);
    } catch (err) {
        if (!(err instanceof BuildError)) throw err;
        printBuildOutput({ type: 'error', message: err.message });
        process.exitCode = 1;
    }
}

// Resolve pnpm's symlink before comparing the invoked executable with this module.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await executeCli(process.argv.slice(2), process.cwd());
}
