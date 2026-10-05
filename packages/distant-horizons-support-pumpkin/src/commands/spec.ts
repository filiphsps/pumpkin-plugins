import { defineCommands } from '@pumpkin-plugins/docs';

/** Operator commands for inspecting DH queues and capability limits. */
export const commands = defineCommands('DistantHorizonsSupportPumpkin', {
    dhs: {
        description: 'Inspect Distant Horizons support',
        permission: 'DistantHorizonsSupportPumpkin:command.dhs',
        subcommands: { status: { description: 'Show connected DH clients and pending requests' } }
    }
});
