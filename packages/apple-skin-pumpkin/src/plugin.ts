import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { PlayerJoinEventData, PlayerLeaveEventData } from 'pumpkin:plugin/event@0.1.0';
import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import { pluginMetadata } from '@pumpkin-plugins/docs';
import { hostLogger } from '@pumpkin-plugins/plugin-kit/host';
import { Plugin, registerPlugin } from '@pumpkinmc/pumpkin-api-ts';
import { info } from './info.ts';
import { PlayerSync } from './platform/player-sync.ts';

/** Tells AppleSkin clients the server's hunger values, which vanilla keeps to itself. */
class AppleSkinPumpkin extends Plugin {
    private readonly sync = new PlayerSync(hostLogger);

    /** Describes the plugin to the server. */
    metadata(): PluginMetadata {
        return pluginMetadata(info, __PLUGIN_VERSION__);
    }

    /** Watches players arrive and leave, and reads everyone's hunger once per tick. */
    onLoad(ctx: Context): void {
        super.onLoad(ctx);
        hostLogger.info(`${info.name} ${__PLUGIN_VERSION__} loaded`);

        this.registerEvent(ctx, 'player-join-event', (_srv, evt: PlayerJoinEventData) => {
            this.sync.joined(evt.player);
        });
        this.registerEvent(ctx, 'player-leave-event', (_srv, evt: PlayerLeaveEventData) => {
            this.sync.left(evt.player);
        });
        this.registerEvent(ctx, 'server-tick-end-event', (srv) => {
            this.sync.tick(srv);
        });
    }
}

registerPlugin(new AppleSkinPumpkin());

export * from '@pumpkinmc/pumpkin-api-ts';
