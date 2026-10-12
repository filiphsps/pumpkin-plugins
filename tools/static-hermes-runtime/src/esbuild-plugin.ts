import type { Plugin } from 'esbuild';

/** Options for resolving Pumpkin package imports while bundling a plugin for Static Hermes. */
export interface StaticHermesImportsOptions {
    resolveDir: string;
}

/** Replaces Pumpkin imports used by the shared plugin kit with Static Hermes host functions. */
export function staticHermesImportsPlugin(options: StaticHermesImportsOptions): Plugin {
    return {
        name: 'pumpkin-static-hermes-imports',
        setup(build) {
            build.onResolve({ filter: /^pumpkin:plugin\/(?:logging|scheduler)@0\.1\.0$/ }, ({ path }) => ({
                path,
                namespace: 'pumpkin-static-hermes'
            }));
            build.onLoad({ filter: /.*/, namespace: 'pumpkin-static-hermes' }, ({ path }) => ({
                loader: 'js',
                contents:
                    path === 'pumpkin:plugin/logging@0.1.0'
                        ? 'export const log = (level, message) => globalThis.__pumpkinHost.log(level, message);'
                        : `
                            export const scheduleDelayedTask = (handlerId, delayTicks) => globalThis.__pumpkinHost.scheduleDelayedTask(handlerId, delayTicks);
                            export const scheduleRepeatingTask = (handlerId, delayTicks, periodTicks) => globalThis.__pumpkinHost.scheduleRepeatingTask(handlerId, delayTicks, periodTicks);
                            export const cancelTask = (taskId) => globalThis.__pumpkinHost.cancelTask(taskId);
                        `
            }));

            build.onResolve({ filter: /^@pumpkin-plugins\/update-check$/ }, ({ path }) => ({
                path,
                namespace: 'pumpkin-static-hermes-update-check'
            }));
            build.onLoad({ filter: /.*/, namespace: 'pumpkin-static-hermes-update-check' }, () => ({
                loader: 'js',
                resolveDir: options.resolveDir,
                contents: `
                    import { registerPlugin } from '@pumpkinmc/pumpkin-api-ts';
                    // Static Hermes does not yet expose WASI HTTP to JavaScript.
                    export function registerPluginWithUpdates(plugin) {
                        registerPlugin(plugin);
                    }
                `
            }));
        }
    };
}
