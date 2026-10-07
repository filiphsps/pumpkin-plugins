import { defineCommands } from '@pumpkin-plugins/docs';
import { PLUGIN_NAME } from '../name.ts';

/** Operator commands for inspecting DH work and managing cached terrain. */
export const commands = defineCommands(PLUGIN_NAME, {
    dhs: {
        description: 'Inspect Distant Horizons support',
        permission: 'DistantHorizonsSupportPumpkin:command.dhs',
        subcommands: {
            status: {
                description: 'Show connected DH clients and pending requests',
                permission: 'DistantHorizonsSupportPumpkin:command.dhs.status'
            },
            cache: {
                description: 'Manage cached LOD terrain',
                permission: 'DistantHorizonsSupportPumpkin:command.dhs.cache',
                subcommands: {
                    status: {
                        description: 'Show memory and disk cache usage',
                        permission: 'DistantHorizonsSupportPumpkin:command.dhs.cache.status'
                    },
                    clear: {
                        description: 'Clear both cache tiers',
                        permission: 'DistantHorizonsSupportPumpkin:command.dhs.cache.clear'
                    },
                    memory: {
                        description: 'Manage the in-memory cache',
                        permission: 'DistantHorizonsSupportPumpkin:command.dhs.cache.memory',
                        subcommands: {
                            clear: {
                                description: 'Clear the in-memory cache',
                                permission: 'DistantHorizonsSupportPumpkin:command.dhs.cache.memory.clear'
                            }
                        }
                    },
                    disk: {
                        description: 'Manage the disk cache',
                        permission: 'DistantHorizonsSupportPumpkin:command.dhs.cache.disk',
                        subcommands: {
                            clear: {
                                description: 'Clear the disk cache',
                                permission: 'DistantHorizonsSupportPumpkin:command.dhs.cache.disk.clear'
                            }
                        }
                    }
                }
            }
        }
    }
});
