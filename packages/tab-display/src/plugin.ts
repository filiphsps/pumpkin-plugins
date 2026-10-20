import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { type ConfigStore, defaultValues } from '@pumpkin-plugins/config';
import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { WasiDataDir } from '@pumpkin-plugins/plugin-kit/data-dir';
import { cancelTask, hostLogger, scheduleRepeating } from '@pumpkin-plugins/plugin-kit/host';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';
import { taggedLogger } from '@pumpkin-plugins/plugin-kit/logger';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { registerCommands } from '@pumpkin-plugins/plugin-kit/register-commands';
import { monotonicMs } from '@pumpkin-plugins/plugin-kit/wasi-clock';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { PieSession } from '@pumpkin-plugins/pumpkin-pie-api';
import { strFromU8, strToU8 } from 'fflate';
import { commandHandlers } from './commands/handlers.ts';
import { commands } from './commands/spec.ts';
import { CONFIG_FILE, configSchema, loadTabDisplayConfig, type TabDisplayConfig } from './config.ts';
import { info } from './info.ts';
import { PLUGIN_NAME } from './name.ts';
import { JavaTabDisplayHost } from './rendering/java.ts';
import { TabDisplayService } from './service.ts';

const log = taggedLogger(`${PLUGIN_NAME}:`, hostLogger);

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
        if (this.files === undefined) log.error('data-folder permissions are unavailable');

        const config = this.loadStartupConfig();
        const host = new JavaTabDisplayHost();
        const session = new PieSession({
            provider: config.placeholders.provider,
            send: ipcSend,
            now: monotonicMs,
            onTransition: (state) => log.info(`PumpkinPIE provider is ${ansi.named.value(state.kind)}`),
        });
        const service = new TabDisplayService({
            host,
            resolver: {
                get state() {
                    return session.state;
                },
                resolveBatch: (requests) => session.client.resolveBatch(requests),
            },
            now: monotonicMs,
            config,
            log: (message) => log.warn(message),
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
                log.warn(`could not restore owned tab fields during unload: ${errorMessage(error)}`);
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
            log.warn(`display tick failed: ${errorMessage(error)}`);
        } finally {
            host.endTick();
        }
    }

    private loadStartupConfig(): TabDisplayConfig {
        try {
            const loaded = loadTabDisplayConfig(this.configStore());
            for (const warning of loaded.warnings) log.warn(`${ansi.named.name(CONFIG_FILE)}: ${warning}`);
            return loaded.config;
        } catch (error) {
            log.error(
                `${ansi.named.name(CONFIG_FILE)} is invalid or unavailable; using defaults: ${errorMessage(error)}`,
            );
            return defaultValues(configSchema);
        }
    }

    // A reload with invalid values keeps the running config, so the command reports them instead.
    private reloadConfig(): { readonly kind: 'applied' } | { readonly kind: 'failed'; readonly reason: string } {
        const service = this.service;
        if (service === undefined) return { kind: 'failed', reason: 'data folder is unavailable' };
        try {
            const loaded = loadTabDisplayConfig(this.configStore());
            if (loaded.warnings.length > 0) return { kind: 'failed', reason: loaded.warnings.join('; ') };
            service.setConfig(loaded.config);
            return { kind: 'applied' };
        } catch (error) {
            return { kind: 'failed', reason: errorMessage(error) };
        }
    }

    private configStore(): ConfigStore {
        const files = this.files;
        if (files === undefined) throw new Error('data folder is unavailable');
        return {
            read: () => {
                const file = files.stat(CONFIG_FILE);
                if (file === undefined) return undefined;
                if (file.kind !== 'file') throw new Error(`${CONFIG_FILE} is not a file`);
                return strFromU8(files.readFile(CONFIG_FILE));
            },
            write: (text) => files.writeFile(CONFIG_FILE, strToU8(text)),
        };
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

registerPlugin(new TabDisplay());

export { handleCommand, handleTask } from '@pumpkin-plugins/plugin-kit/plugin';

export * from '@pumpkin-plugins/pumpkin-api';
