import type { CommandSender, ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { now as monotonicNow } from 'wasi:clocks/monotonic-clock@0.2.3';
import { WasiDataDir } from '@pumpkin-plugins/plugin-kit/data-dir';
import { cancelTask, runCommand as runHostCommand, scheduleRepeating } from '@pumpkin-plugins/plugin-kit/host';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { registerCommands } from '@pumpkin-plugins/plugin-kit/register-commands';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { handleCommand as apiHandleCommand } from '@pumpkin-plugins/pumpkin-api';
import { PieSession } from '@pumpkin-plugins/pumpkin-pie-api';
import { strFromU8, strToU8 } from 'fflate';
import { commandHandlers } from './commands/handlers.ts';
import { commands } from './commands/spec.ts';
import { CONFIG_FILE, loadTabDisplayConfig, type TabDisplayConfig } from './config.ts';
import { createConfigTransaction } from './config-store.ts';
import { info } from './info.ts';
import { PLUGIN_NAME } from './name.ts';
import { JavaTabDisplayHost } from './rendering/java.ts';
import { TabDisplayService } from './service.ts';

/** The plugin. Pumpkin creates it once and calls `onLoad` when the server starts. */
class TabDisplay extends PluginBase {
    private files: WasiDataDir | undefined;
    private host: JavaTabDisplayHost | undefined;
    private service: TabDisplayService | undefined;
    private session: PieSession | undefined;
    private taskId: number | undefined;

    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    /** Loads validated config, starts one PIE session and registers operator diagnostics. */
    protected onPluginLoad(ctx: Context): void {
        this.files = WasiDataDir.open();
        if (this.files === undefined) logging.log('error', `${PLUGIN_NAME}: data-folder permissions are unavailable`);

        const config = this.loadStartupConfig();
        const host = new JavaTabDisplayHost();
        const session = new PieSession({
            provider: config.placeholders.provider,
            send: ipcSend,
            now: monotonicMilliseconds,
            onTransition: (state) => logging.log('info', `${PLUGIN_NAME}: PumpkinPIE provider is ${state.kind}`),
        });
        const service = new TabDisplayService({
            host,
            resolver: {
                get state() {
                    return session.state;
                },
                resolveBatch: (requests) => session.client.resolveBatch(requests),
            },
            now: monotonicMilliseconds,
            config,
            log: (message) => logging.log('warn', `${PLUGIN_NAME}: ${message}`),
        });

        this.host = host;
        this.session = session;
        this.service = service;
        this.taskId = scheduleRepeating(1, (server) => this.tick(server));
        registerCommands(
            ctx,
            commands,
            commandHandlers({
                status: () => service.status(),
                reload: () => this.reloadConfig(),
                inspect: (uuid) => {
                    const player = service.inspect(uuid);
                    if (player === undefined) return undefined;
                    return {
                        uuid: player.uuid,
                        name: player.name,
                        edition: player.edition,
                        ...(player.javaVersion === undefined ? {} : { javaVersion: player.javaVersion }),
                        placeholderIds: player.placeholderIds,
                    };
                },
            }),
        );
    }

    /** Stops scheduled work, unregisters PIE callbacks and restores online owned fields. */
    protected override onPluginUnload(ctx: Context): void {
        if (this.taskId !== undefined) cancelTask(this.taskId);
        this.taskId = undefined;
        // Pumpkin may already be stopping the WASM store, so teardown must not re-enter it over IPC.
        this.session?.stop({ unregister: false });

        if (this.host !== undefined && this.service !== undefined) {
            const server = ctx.getServer();
            try {
                this.host.setServer(server);
                this.host.snapshotPlayers(5000);
                this.service.shutdown();
            } catch (error) {
                logging.log(
                    'warn',
                    `${PLUGIN_NAME}: could not restore owned tab fields during unload: ${errorMessage(error)}`,
                );
            } finally {
                this.host.endTick();
                disposeWasiResource(server);
            }
        }

        disposeWasiResource(this.files);
        this.files = undefined;
        this.host = undefined;
        this.service = undefined;
        this.session = undefined;
    }

    private tick(server: Server): void {
        const host = this.host;
        const service = this.service;
        const session = this.session;
        if (host === undefined || service === undefined || session === undefined) return;
        host.setServer(server);
        try {
            session.tick();
            service.tick();
        } catch (error) {
            logging.log('warn', `${PLUGIN_NAME}: display tick failed: ${errorMessage(error)}`);
        } finally {
            host.endTick();
        }
    }

    private loadStartupConfig(): TabDisplayConfig {
        try {
            const transaction = this.configTransaction();
            const loaded = loadTabDisplayConfig(transaction.store);
            transaction.commit();
            return loaded.config;
        } catch (error) {
            logging.log(
                'error',
                `${PLUGIN_NAME}: invalid or unavailable config; using defaults: ${errorMessage(error)}`,
            );
            return loadTabDisplayConfig({ read: () => undefined, write: () => undefined }).config;
        }
    }

    private reloadConfig(): { readonly kind: 'applied' } | { readonly kind: 'failed'; readonly reason: string } {
        const files = this.files;
        const service = this.service;
        if (files === undefined || service === undefined) {
            return { kind: 'failed', reason: 'data folder is unavailable' };
        }
        try {
            const transaction = this.configTransaction();
            const loaded = loadTabDisplayConfig(transaction.store);
            transaction.commit();
            const result = service.setConfig(loaded.config);
            return result.kind === 'applied'
                ? { kind: 'applied' }
                : { kind: 'failed', reason: result.kind === 'failed' ? result.error : 'configuration was not applied' };
        } catch (error) {
            return { kind: 'failed', reason: errorMessage(error) };
        }
    }

    private configTransaction() {
        const files = this.files;
        if (files === undefined) throw new Error('data folder is unavailable');
        return createConfigTransaction(
            () => {
                const file = files.stat(CONFIG_FILE);
                if (file === undefined) return undefined;
                if (file.kind !== 'file') throw new Error(`${CONFIG_FILE} is not a file`);
                return strFromU8(files.readFile(CONFIG_FILE));
            },
            (text) => files.writeFile(CONFIG_FILE, strToU8(text)),
        );
    }
}

function monotonicMilliseconds(): number {
    return Number(monotonicNow() / 1_000_000n);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

registerPlugin(new TabDisplay());

export { handleTask } from '@pumpkin-plugins/plugin-kit/plugin';

/** Dispatches registered TabDisplay commands before delegating to Pumpkin's API package. */
export function handleCommand(id: number, sender: CommandSender, server: Server, args: ConsumedArgs): number {
    return runHostCommand(id, sender, args) ?? apiHandleCommand(id, sender, server, args);
}

export * from '@pumpkin-plugins/pumpkin-api';
