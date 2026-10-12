import type { Plugin } from 'esbuild';
import type { WitApiInterface, WitWasiInterface } from '../bin/wit-api.mjs';
import { generateEsmFacade, generateWasiEsmFacade, readWasiWitImports, readWitPackage } from '../bin/wit-api.mjs';

/** Options for resolving Pumpkin package imports while bundling a plugin for Static Hermes. */
export interface StaticHermesImportsOptions {
    resolveDir: string;
    /** WIT world used by the component build. Pumpkin interfaces are generated from this source. */
    witDir: string;
    /** Excludes automatic update checks from development bundles. */
    developmentMode?: boolean;
    /** Called for each WASI module backed by generated JSI runtime code. */
    onWasiImport?: (specifier: string) => void;
}

/** Replaces imported Pumpkin interfaces with facades generated from the plugin's WIT world. */
export function staticHermesImportsPlugin(options: StaticHermesImportsOptions): Plugin {
    const pumpkinWit = readWitPackage(options.witDir);
    const pumpkinModules = new Map<string, string>(
        pumpkinWit.interfaces.map((apiInterface: WitApiInterface) => [
            apiInterface.specifier,
            generateEsmFacade(apiInterface, pumpkinWit.interfaces)
        ])
    );
    const wasiModules = new Map<string, string>(
        readWasiWitImports(options.witDir).interfaces.map((apiInterface: WitWasiInterface) => [
            apiInterface.specifier,
            generateWasiEsmFacade(apiInterface)
        ])
    );

    return {
        name: 'pumpkin-static-hermes-imports',
        setup(build) {
            build.onResolve({ filter: /^pumpkin:/ }, ({ path }) => {
                if (!pumpkinModules.has(path)) {
                    throw new Error(`${path} is not imported by the plugin's WIT world`);
                }
                return { path, namespace: 'pumpkin-static-hermes-api' };
            });
            build.onLoad({ filter: /.*/, namespace: 'pumpkin-static-hermes-api' }, ({ path }) => ({
                loader: 'js',
                contents: pumpkinModules.get(path)
            }));

            build.onResolve({ filter: /^wasi:/ }, ({ path }) => {
                if (!wasiModules.has(path)) {
                    throw new Error(`${path} is not imported or referenced by the plugin's WIT world`);
                }
                options.onWasiImport?.(path);
                return { path, namespace: 'pumpkin-static-hermes-wasi-adapter' };
            });
            build.onLoad({ filter: /.*/, namespace: 'pumpkin-static-hermes-wasi-adapter' }, ({ path }) => ({
                loader: 'js',
                contents: wasiModules.get(path)
            }));

            if (options.developmentMode) {
                build.onResolve({ filter: /^@pumpkin-plugins\/update-check$/ }, ({ path }) => ({
                    path,
                    namespace: 'pumpkin-static-hermes-dev-update-check'
                }));
                build.onLoad({ filter: /.*/, namespace: 'pumpkin-static-hermes-dev-update-check' }, () => ({
                    loader: 'js',
                    resolveDir: options.resolveDir,
                    contents: `
                        import { registerPlugin } from '@pumpkinmc/pumpkin-api-ts';
                        export function registerPluginWithUpdates(plugin) { registerPlugin(plugin); }
                    `
                }));
            }
        }
    };
}
