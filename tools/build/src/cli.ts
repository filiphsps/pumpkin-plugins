import { createRequire } from 'node:module';
import * as path from 'node:path';
import { bundlePlugin } from './bundle.ts';
import { wasiInterfaces } from './capabilities.ts';
import { BuildError } from './errors.ts';
import { readPluginConfig, requireBuildFields } from './plugin-config.ts';
import { cacheDir } from './repo.ts';
import { generateTypes } from './types.ts';
import { ensureWasiWit, readLock } from './wasi-wit.ts';
import { prepareWit } from './wit.ts';

/**
 * Builds the plugin in `pluginDir`, or with `--types-only` just its type declarations.
 * `PUMPKIN_API_DIR` points at a different `pumpkin-api-ts` checkout.
 * @param args - Command line arguments.
 * @param pluginDir - The package to build.
 */
export async function run(args: string[], pluginDir: string): Promise<void> {
    const unknownArgument = args.find((arg) => arg !== '--types-only');
    if (unknownArgument) throw new BuildError(`unknown argument "${unknownArgument}" (supported: --types-only)`);

    const config = readPluginConfig(pluginDir);
    const buildFields = args.includes('--types-only') ? undefined : requireBuildFields(config);
    const buildDir = path.join(pluginDir, 'build');
    const apiRoot = process.env.PUMPKIN_API_DIR
        ? path.resolve(process.env.PUMPKIN_API_DIR)
        : path.dirname(
              createRequire(path.join(pluginDir, 'package.json')).resolve('@pumpkinmc/pumpkin-api-ts/package.json')
          );
    const interfaces = wasiInterfaces(config.wasi);
    const wasiLock = readLock();
    const wasiWit =
        interfaces.length > 0 ? await ensureWasiWit({ cacheDir: cacheDir(pluginDir), lock: wasiLock }) : undefined;
    const wasiFiles = Object.keys(wasiLock.files);
    const apiWit = path.join(apiRoot, 'wit/v0.1');

    // Types go to build/types so `types` and `build` can run in parallel (turbo) without sharing files.
    if (!buildFields) {
        const witDir = prepareWit({
            apiWit,
            interfaces,
            wasiWit,
            wasiFiles,
            target: path.join(buildDir, 'types', 'wit')
        });
        generateTypes(witDir, path.join(buildDir, 'types', 'bindings'));
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
    console.log(`Bundling ${entry}...`);
    const size = await bundlePlugin({
        entry: path.resolve(pluginDir, entry),
        output: path.resolve(pluginDir, output),
        witDir,
        version: config.version
    });
    console.log(`Built ${output} (${(size / 1024).toFixed(0)} KiB)`);
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
        console.error(`pumpkin-plugins-build: ${err.message}`);
        process.exit(1);
    }
}
