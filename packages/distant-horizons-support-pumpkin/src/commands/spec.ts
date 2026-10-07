import { defineCommands } from '@pumpkin-plugins/docs';
import { MAX_LOD_GENERATION_RADIUS } from '../lod/generation.ts';
import { MAX_LOD_MAP_RADIUS } from '../lod/map-constants.ts';
import { PLUGIN_NAME } from '../name.ts';

/** Permission node required to use the `/dhs` commands. */
export const COMMAND_PERMISSION = `${PLUGIN_NAME}:command.dhs` as const;

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
                description: 'Visualize cached LOD sections',
                permission: `${COMMAND_PERMISSION}.map`,
                subcommands: {
                    here: {
                        description: 'Show cached LOD sections around your position (default radius 4 sections)',
                        permission: `${COMMAND_PERMISSION}.map.here`
                    },
                    'here-radius': {
                        description: `Show cached LOD sections around your position with radius 0–${MAX_LOD_MAP_RADIUS} sections`,
                        permission: `${COMMAND_PERMISSION}.map.here-radius`,
                        arguments: [{ name: 'radius', type: 'integer', min: 0, max: MAX_LOD_MAP_RADIUS }]
                    },
                    at: {
                        description:
                            'Show cached LOD sections around block coordinates in your current world (default radius 4 sections)',
                        permission: `${COMMAND_PERMISSION}.map.at`,
                        arguments: [
                            { name: 'x', type: 'integer' },
                            { name: 'z', type: 'integer' }
                        ]
                    },
                    'at-radius': {
                        description: `Show cached LOD sections at block coordinates with radius 0–${MAX_LOD_MAP_RADIUS} sections`,
                        permission: `${COMMAND_PERMISSION}.map.at-radius`,
                        arguments: [
                            { name: 'x', type: 'integer' },
                            { name: 'z', type: 'integer' },
                            { name: 'radius', type: 'integer', min: 0, max: MAX_LOD_MAP_RADIUS }
                        ]
                    }
                }
            },
            generate: {
                description: 'Force-build and cache LOD sections at full work speed',
                permission: `${COMMAND_PERMISSION}.generate`,
                subcommands: {
                    here: {
                        description: 'Force-build the LOD section at your current position',
                        permission: `${COMMAND_PERMISSION}.generate.here`
                    },
                    'here-radius': {
                        description: `Force-build LOD sections around your position with radius 0–${MAX_LOD_GENERATION_RADIUS}`,
                        permission: `${COMMAND_PERMISSION}.generate.here-radius`,
                        arguments: [{ name: 'radius', type: 'integer', min: 0, max: MAX_LOD_GENERATION_RADIUS }]
                    },
                    at: {
                        description: 'Force-build the LOD section at block coordinates in your current world',
                        permission: `${COMMAND_PERMISSION}.generate.at`,
                        arguments: [
                            { name: 'x', type: 'integer' },
                            { name: 'z', type: 'integer' }
                        ]
                    },
                    'at-radius': {
                        description: `Force-build LOD sections at block coordinates with radius 0–${MAX_LOD_GENERATION_RADIUS}`,
                        permission: `${COMMAND_PERMISSION}.generate.at-radius`,
                        arguments: [
                            { name: 'x', type: 'integer' },
                            { name: 'z', type: 'integer' },
                            { name: 'radius', type: 'integer', min: 0, max: MAX_LOD_GENERATION_RADIUS }
                        ]
                    }
                }
            }
        }
    }
});
