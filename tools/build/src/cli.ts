#!/usr/bin/env node
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from '@commander-js/extra-typings';
import { ensurePumpkinWit } from '@pumpkin-plugins/pumpkin-api/wit';
import { CommanderError } from 'commander';
import { bundlePlugin } from './bundle.ts';
import { wasiInterfaces } from './capabilities.ts';
import { BuildError } from './errors.ts';
import { printBuildOutput } from './output.ts';
import { readPluginConfig, requireBuildFields } from './plugin-config.ts';
import { cacheDir } from './repo.ts';
import { generateTypes } from './types.ts';
import { ensureWasiWit, readLock } from './wasi-wit.ts';
import { prepareWit } from './wit.ts';

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
        .configureOutput({ outputError: () => {} })
        .exitOverride();
    try {
        command.parse(args, { from: 'user' });
    } catch (error) {
        if (!(error instanceof CommanderError)) throw error;
        if (error.exitCode === 0) return;
        throw new BuildError(error.message.replace(/^error: /, ''));
    }
    const { typesOnly } = command.opts();

    const config = readPluginConfig(pluginDir);
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
                    target: path.join(temporaryWitRoot, 'wit')
                });
            }
            generateTypes(witDir, path.join(buildDir, 'types', 'bindings'));
            fs.rmSync(path.join(buildDir, 'types', 'wit'), { recursive: true, force: true });
        } finally {
            if (temporaryWitRoot !== undefined) fs.rmSync(temporaryWitRoot, { recursive: true, force: true });
        }
        return;
    }

    const { entry, output } = buildFields;
    const witDir = prepareWit({
        apiWit,
        interfaces,
        wasiWit,
        wasiFiles,
        target: path.join(buildDir, 'wit')
    });
    const engine = config.engine ?? 'static-hermes';
    const staticHermesRuntime =
        engine === 'static-hermes'
            ? process.env.STATIC_HERMES_ENABLE_LEAN_ARCHIVE === '0'
                ? 'full'
                : (config.staticHermesRuntime ?? 'lean')
            : undefined;
    printBuildOutput({
        type: 'bundle',
        entry,
        engine,
        ...(staticHermesRuntime === undefined ? {} : { runtimeVariant: staticHermesRuntime })
    });
    const size = await bundlePlugin({
        projectRoot: pluginDir,
        entry: path.resolve(pluginDir, entry),
        output: path.resolve(pluginDir, output),
        witDir,
        version: config.version,
        engine,
        quietRuntimeOutput: true,
        onOutput: printBuildOutput,
        ...(staticHermesRuntime === undefined ? {} : { staticHermesRuntime }),
        developmentMode: process.env.PUMPKIN_DEV_MODE === '1'
    });
    printBuildOutput({ type: 'built', output, sizeBytes: size });
}

/**
 * Resolves the Pumpkin API package and fetches its pinned WIT into the consumer cache.
 *
 * @param pluginDir - Root directory of the consuming plugin project.
 * @param resolvePackageJson - Resolver for the API package manifest, injectable for isolated callers.
 * @returns The cached WIT directory selected by the API package's `wit.lock.json`.
 * @throws {BuildError} If the API package, pin, Git checkout, or WIT files cannot be resolved.
 */
export function resolveApiWit(
    pluginDir: string,
    resolvePackageJson: (pluginDir: string) => string = (root) =>
        createRequire(path.join(root, 'package.json')).resolve('@pumpkin-plugins/pumpkin-api/package.json')
): string {
    let packageJson: string;
    try {
        packageJson = resolvePackageJson(pluginDir);
    } catch {
        throw new BuildError(
            'cannot resolve @pumpkin-plugins/pumpkin-api from this plugin; add it to the plugin dependencies and run your package manager install'
        );
    }

    const apiRoot = path.dirname(packageJson);
    const lockFile = path.join(apiRoot, 'wit.lock.json');
    try {
        return ensurePumpkinWit({ lockFile, cacheRoot: cacheDir(pluginDir) });
    } catch (error) {
        throw new BuildError(
            `could not resolve pinned WIT for @pumpkin-plugins/pumpkin-api: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/**
 * The command line entry point: runs and turns a `BuildError` into a one-line message.
 * @param args - Command line arguments.
 * @param pluginDir - The package to build.
 */
export async function main(args: string[], pluginDir: string): Promise<void> {
    try {
        await run(args, pluginDir);
    } catch (err) {
        if (!(err instanceof BuildError)) throw err;
        printBuildOutput({ type: 'error', message: err.message });
        process.exit(1);
    }
}

// Resolve pnpm's symlink before comparing the invoked executable with this module.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main(process.argv.slice(2), process.cwd());
}
