import type { Plugin } from 'esbuild';
import { setupHermesToolchainEnvironment } from './hermes/toolchain-environment.ts';
import { emitPumpkinFacade, emitWasiFacade } from './wit/emitters.ts';
import { readInterfaceDeclarationOrder, readPluginImportOrder, readWitToolsDocument } from './wit/parser.ts';
import { resolvePluginApi, resolveWasiImports, resolveWitDocument } from './wit/resolver.ts';
import { resolveConsumerWorkspaceRoot } from './workspace-root.ts';

/** Options for resolving Pumpkin and WASI package imports while bundling for Static Hermes. */
export interface StaticHermesImportsOptions {
    /**
     * Ignored. update-check skips its automatic check in development bundles through `__PUMPKIN_DEV_MODE__`.
     * @deprecated Has no effect.
     */
    developmentMode?: boolean;
    /** Called for each resolved WASI import so the component build can select its adapters. */
    onWasiImport?: (specifier: string) => void;
    /**
     * Ignored. It resolved the development update-check stub this plugin no longer provides.
     * @deprecated Has no effect.
     */
    resolveDir?: string;
    /** Prepared WIT world used to resolve and generate Pumpkin and WASI interfaces. */
    witDir: string;
    /** Consumer project directory used to find the nearest pnpm workspace root for runtime toolchain caches. */
    workspaceRoot?: string;
}

/**
 * Resolves imported Pumpkin and WASI interfaces from the plugin's WIT world and provides generated facades.
 *
 * @remarks
 * The setup hook resolves the pinned `wasm-tools` binary before registering module handlers. Imports that are
 * absent from the WIT world fail the esbuild build.
 *
 * @param options - WIT inputs and callbacks used to resolve the bundle's imports.
 * @returns An esbuild plugin that loads generated Pumpkin and WASI facade modules.
 */
export function staticHermesImportsPlugin(options: StaticHermesImportsOptions): Plugin {
    return {
        name: 'pumpkin-static-hermes-imports',
        async setup(build) {
            const toolchain = await setupHermesToolchainEnvironment({
                workspaceRoot: resolveConsumerWorkspaceRoot(options.workspaceRoot),
                includeWasiSdk: false,
                includeWitBindgen: false,
                includeWasmTools: true,
            });
            Object.assign(process.env, toolchain);
            const importOrder = readPluginImportOrder(options.witDir);
            const document = readWitToolsDocument(options.witDir);
            const resolved = resolveWitDocument(document, readInterfaceDeclarationOrder(options.witDir));
            const pumpkinWit = resolvePluginApi(resolved, importOrder);
            const wasiWit = resolveWasiImports(resolved, undefined, importOrder);
            const pumpkinModules = new Map<string, string>(
                pumpkinWit.interfaces.map((apiInterface) => [
                    apiInterface.specifier,
                    emitPumpkinFacade(apiInterface, pumpkinWit.interfaces),
                ]),
            );
            const wasiModules = new Map<string, string>(
                wasiWit.interfaces.map((apiInterface) => [apiInterface.specifier, emitWasiFacade(apiInterface)]),
            );
            build.onResolve({ filter: /^pumpkin:/ }, ({ path }) => {
                if (!pumpkinModules.has(path)) {
                    throw new Error(`${path} is not imported by the plugin's WIT world`);
                }
                return { path, namespace: 'pumpkin-static-hermes-api' };
            });
            build.onLoad({ filter: /.*/, namespace: 'pumpkin-static-hermes-api' }, ({ path }) => ({
                loader: 'js',
                contents: pumpkinModules.get(path),
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
                contents: wasiModules.get(path),
            }));
        },
    };
}
