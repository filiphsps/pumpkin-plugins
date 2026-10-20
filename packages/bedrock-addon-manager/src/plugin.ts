import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { WasiDataDir } from '@pumpkin-plugins/plugin-kit/data-dir';
import { cancelTask, hostLogger, scheduleRepeating } from '@pumpkin-plugins/plugin-kit/host';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';
import { taggedLogger } from '@pumpkin-plugins/plugin-kit/logger';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { registerCommands } from './commands/register.ts';
import { info } from './info.ts';
import { PackManager } from './manager.ts';
import { TcpWebServer } from './web/tcp-server.ts';

const log = taggedLogger(`${ansi.named.name(info.name)}:`, hostLogger);

/** Serves Bedrock resource packs over HTTP. */
class BedrockAddonManager extends PluginBase {
    private files: WasiDataDir | undefined;
    private manager: PackManager | undefined;
    private tickTask: number | undefined;

    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    /** Starts the pack manager, schedules its tick and registers the `/baddon` commands. */
    protected onPluginLoad(ctx: Context): void {
        const files = WasiDataDir.open();
        if (!files) {
            log.error(
                'Cannot reach the data folder. Grant this plugin the fs.read.data and fs.write.data permissions and restart the server.',
            );
            return;
        }
        this.files = files;

        const manager = new PackManager(
            files,
            log,
            (index) => new TcpWebServer((name) => index.open(name), log),
            ipcSend,
        );
        manager.start();
        this.manager = manager;
        this.tickTask = scheduleRepeating(1, () => manager.tick());
        registerCommands(ctx, manager);
    }

    /** Stops the tick and the web server. */
    protected override onPluginUnload(_ctx: Context): void {
        const files = this.files;
        this.files = undefined;
        const tickTask = this.tickTask;
        let cleanupFailed = false;
        let firstCleanupError: unknown;
        const attemptCleanup = (cleanup: () => void): void => {
            try {
                cleanup();
            } catch (error) {
                if (cleanupFailed) return;
                cleanupFailed = true;
                firstCleanupError = error;
            }
        };

        if (tickTask !== undefined) attemptCleanup(() => cancelTask(tickTask));
        attemptCleanup(() => this.manager?.stop({ releasePort: false }));
        attemptCleanup(() => disposeWasiResource(files));

        if (cleanupFailed) throw firstCleanupError;
    }
}

registerPlugin(new BedrockAddonManager());

export { handleCommand, handleTask } from '@pumpkin-plugins/plugin-kit/plugin';

export * from '@pumpkin-plugins/pumpkin-api';
