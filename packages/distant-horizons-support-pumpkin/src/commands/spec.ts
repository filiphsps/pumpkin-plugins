import { defineCommands } from '@pumpkin-plugins/docs';

/** Operator commands for inspecting DH work and managing cached terrain. */
export const commands = defineCommands('DistantHorizonsSupportPumpkin', {
    dhs: {
        description: 'Inspect Distant Horizons support',
        permission: 'DistantHorizonsSupportPumpkin:command.dhs',
        subcommands: {
            status: { description: 'Show connected DH clients and pending requests' },
            cache: {
                description: 'Manage cached LOD terrain',
                subcommands: {
                    status: { description: 'Show memory and disk cache usage' },
                    clear: { description: 'Clear both cache tiers' },
                    memory: {
                        description: 'Manage the in-memory cache',
                        subcommands: { clear: { description: 'Clear the in-memory cache' } }
                    },
                    disk: {
                        description: 'Manage the disk cache',
                        subcommands: { clear: { description: 'Clear the disk cache' } }
                    }
                }
            }
        }
    }
});
