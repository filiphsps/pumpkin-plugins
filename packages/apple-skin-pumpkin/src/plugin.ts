import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { PlayerJoinEventData, PlayerLeaveEventData } from 'pumpkin:plugin/event@0.1.0';
import { hostLogger } from '@pumpkin-plugins/plugin-kit/host';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { info } from './info.ts';
import { PlayerSync } from './platform/player-sync.ts';

/** Tells AppleSkin clients the server's hunger values, which vanilla keeps to itself. */
class AppleSkinPumpkin extends PluginBase {
    private readonly sync = new PlayerSync(hostLogger);

    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    /** Watches players arrive and leave, and reads everyone's hunger once per tick. */
    protected onPluginLoad(ctx: Context): void {
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

export { handleTask } from '@pumpkin-plugins/plugin-kit/plugin';
export * from '@pumpkinmc/pumpkin-api-ts';
