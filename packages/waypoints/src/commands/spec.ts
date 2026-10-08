import { defineCommands } from '@pumpkin-plugins/docs';
import { PLUGIN_NAME } from '../name.ts';

/** Permission node for player-facing waypoint commands. */
export const COMMAND_PERMISSION = `${PLUGIN_NAME}:command.use` as const;

/** Single operator override shared by administrative commands and waypoint policy checks. */
export const ADMIN_PERMISSION = `${PLUGIN_NAME}:command.admin` as const;

const nameArgument = { name: 'name', type: 'string', mode: 'quotable' } as const;
const idArgument = { name: 'id', type: 'string', mode: 'single-word' } as const;
const playerArgument = { name: 'player', type: 'string', mode: 'single-word' } as const;
const s32 = { min: -2_147_483_648, max: 2_147_483_647 } as const;

/** The single command declaration used for Pumpkin registration, handler types, and README usage. */
export const commands = defineCommands(PLUGIN_NAME, {
    wp: {
        description: 'Create and manage server waypoints',
        permission: COMMAND_PERMISSION,
        defaultPermission: { tag: 'allow' },
        subcommands: {
            mark: {
                description: 'Save your current block position as a private waypoint',
                arguments: [nameArgument]
            },
            add: {
                description: 'Save block coordinates as a private waypoint',
                arguments: [
                    nameArgument,
                    { name: 'x', type: 'integer', ...s32 },
                    { name: 'y', type: 'integer', ...s32 },
                    { name: 'z', type: 'integer', ...s32 }
                ]
            },
            list: {
                description: 'List waypoints you can access; use all to include other dimensions',
                argumentVariants: [[{ name: 'scope', type: 'string', mode: 'single-word' }]]
            },
            show: {
                description: 'Show an accessible waypoint by UUID',
                arguments: [idArgument]
            },
            access: {
                description: 'Change visibility and allowlist access',
                subcommands: {
                    public: { description: 'Make a waypoint visible to everyone', arguments: [idArgument] },
                    private: { description: 'Make a waypoint visible only to its owner', arguments: [idArgument] },
                    allowlist: {
                        description: 'Limit a waypoint to its owner and invited players',
                        arguments: [idArgument]
                    },
                    invite: {
                        description: 'Invite an online player to an allowlisted waypoint',
                        arguments: [idArgument, playerArgument]
                    },
                    revoke: {
                        description: 'Remove an online player from a waypoint allowlist',
                        arguments: [idArgument, playerArgument]
                    }
                }
            },
            locator: {
                description: 'Configure a waypoint on the Java Locator Bar',
                subcommands: {
                    on: { description: 'Enable locator output for a waypoint', arguments: [idArgument] },
                    off: { description: 'Disable locator output for a waypoint', arguments: [idArgument] },
                    color: {
                        description: 'Set or reset a waypoint RGB color',
                        arguments: [idArgument, { name: 'hex', type: 'string', mode: 'single-word' }]
                    },
                    'java-style': {
                        description: 'Set or reset a Java waypoint style resource ID',
                        arguments: [idArgument, { name: 'style', type: 'string', mode: 'single-word' }]
                    }
                }
            },
            remove: {
                description: 'Remove a waypoint you own',
                arguments: [idArgument]
            },
            send: {
                description: 'Show a waypoint to yourself through a map adapter',
                arguments: [idArgument, { name: 'adapter', type: 'string', mode: 'single-word' }]
            },
            'send-to': {
                description: 'Send an accessible waypoint to an online player',
                arguments: [idArgument, playerArgument, { name: 'adapter', type: 'string', mode: 'single-word' }]
            },
            admin: {
                description: 'Administer every waypoint',
                permission: ADMIN_PERMISSION,
                defaultPermission: { tag: 'op', val: 'three' },
                subcommands: {
                    list: { description: 'List every saved waypoint' },
                    remove: { description: 'Remove any waypoint by UUID', arguments: [idArgument] }
                }
            }
        }
    }
});
