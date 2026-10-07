import { defineCommands } from '@pumpkin-plugins/docs';
import { MAX_LOD_GENERATION_RADIUS } from '../lod/generation.ts';
import { MAX_LOD_MAP_RADIUS } from '../lod/map-constants.ts';
import { PLUGIN_NAME } from '../name.ts';

/** Permission node required to use the `/dhs` commands. */
export const COMMAND_PERMISSION = `${PLUGIN_NAME}:command.dhs` as const;
const mapRadiusLimit = MAX_LOD_MAP_RADIUS.toLocaleString('en-US').replace(/,/g, '_');
const generationRadiusLimit = MAX_LOD_GENERATION_RADIUS.toLocaleString('en-US').replace(/,/g, '_');

/** Operator commands for inspecting DH work and managing cached terrain. */
export const commands = defineCommands(PLUGIN_NAME, {
    dhs: {
        description: 'Inspect Distant Horizons support',
        permission: COMMAND_PERMISSION,
        subcommands: {
            status: {
                description: 'Show connected DH clients and pending requests',
                permission: `${COMMAND_PERMISSION}.status`
            },
            cache: {
                description: 'Manage cached LOD terrain',
                permission: `${COMMAND_PERMISSION}.cache`,
                subcommands: {
                    status: {
                        description: 'Show memory and disk cache usage',
                        permission: `${COMMAND_PERMISSION}.cache.status`
                    },
                    clear: {
                        description: 'Clear both cache tiers',
                        permission: `${COMMAND_PERMISSION}.cache.clear`
                    },
                    memory: {
                        description: 'Manage the in-memory cache',
                        permission: `${COMMAND_PERMISSION}.cache.memory`,
                        subcommands: {
                            clear: {
                                description: 'Clear the in-memory cache',
                                permission: `${COMMAND_PERMISSION}.cache.memory.clear`
                            }
                        }
                    },
                    disk: {
                        description: 'Manage the disk cache',
                        permission: `${COMMAND_PERMISSION}.cache.disk`,
                        subcommands: {
                            clear: {
                                description: 'Clear the disk cache',
                                permission: `${COMMAND_PERMISSION}.cache.disk.clear`
                            }
                        }
                    }
                }
            },
            map: {
                description: `Show cached LOD sections at your position or block coordinates (default radius 4; maximum ${mapRadiusLimit} sections)`,
                permission: `${COMMAND_PERMISSION}.map`,
                argumentVariants: [
                    [{ name: 'radius', type: 'integer', min: 0, max: MAX_LOD_MAP_RADIUS }],
                    [
                        { name: 'x', type: 'integer' },
                        { name: 'z', type: 'integer' }
                    ],
                    [
                        { name: 'x', type: 'integer' },
                        { name: 'z', type: 'integer' },
                        { name: 'radius', type: 'integer', min: 0, max: MAX_LOD_MAP_RADIUS }
                    ]
                ]
            },
            generate: {
                description: `Force-build LOD sections at your position or block coordinates (default radius 0; maximum ${generationRadiusLimit} sections)`,
                permission: `${COMMAND_PERMISSION}.generate`,
                argumentVariants: [
                    [{ name: 'radius', type: 'integer', min: 0, max: MAX_LOD_GENERATION_RADIUS }],
                    [
                        { name: 'x', type: 'integer' },
                        { name: 'z', type: 'integer' }
                    ],
                    [
                        { name: 'x', type: 'integer' },
                        { name: 'z', type: 'integer' },
                        { name: 'radius', type: 'integer', min: 0, max: MAX_LOD_GENERATION_RADIUS }
                    ]
                ]
            }
        }
    }
});
