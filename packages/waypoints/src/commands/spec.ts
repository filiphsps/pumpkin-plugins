import { type CommandArgumentSpec, defineCommands } from '@pumpkin-plugins/docs';
import { PLUGIN_NAME } from '../name.ts';

/** Permission node for player-readable waypoint commands. */
export const COMMAND_PERMISSION = `${PLUGIN_NAME}:command.use` as const;

/** Command-tree default for mutations; handlers still verify actual Pumpkin operator status. */
export const ADMIN_PERMISSION = `${PLUGIN_NAME}:command.admin` as const;

const ADMIN_DEFAULT = { tag: 'op', val: 'three' } as const;
const name = { name: 'name', type: 'string', mode: 'quotable' } as const;
const newName = { name: 'newName', type: 'string', mode: 'quotable' } as const;
const player = { name: 'player', type: 'string', mode: 'single-word' } as const;
const permission = { name: 'permission', type: 'string', mode: 'single-word' } as const;
const group = { name: 'group', type: 'string', mode: 'single-word' } as const;
const hex = { name: 'hex', type: 'string', mode: 'single-word' } as const;
// The pinned Pumpkin host drops parsed ItemStacks from ConsumedArgs; keep the raw key for validation.
const item = { name: 'item', type: 'string', mode: 'greedy' } as const;
const label = { name: 'label', type: 'string', mode: 'greedy' } as const;
const description = { name: 'description', type: 'string', mode: 'greedy' } as const;
const coordinate = { min: -30_000_000, max: 30_000_000 } as const;

function admin<const Arguments extends readonly [CommandArgumentSpec, ...CommandArgumentSpec[]]>(
    description_: string,
    arguments_: Arguments
) {
    return {
        description: description_,
        permission: ADMIN_PERMISSION,
        defaultPermission: ADMIN_DEFAULT,
        arguments: arguments_
    } as const;
}

const namedCoordinateVariants = [
    [name],
    [
        name,
        { name: 'x', type: 'double', ...coordinate },
        { name: 'y', type: 'double' },
        { name: 'z', type: 'double', ...coordinate }
    ]
] as const;
const teleportVariants = [[name], [name, { name: 'targets', type: 'players' }]] as const;

/** The single declaration used for Pumpkin registration, typed handlers, and generated README usage. */
export const commands = defineCommands(PLUGIN_NAME, {
    wp: {
        description: 'Create and manage server waypoints',
        permission: COMMAND_PERMISSION,
        defaultPermission: { tag: 'allow' },
        subcommands: {
            create: {
                description: 'Create a waypoint at your position or explicit coordinates',
                permission: ADMIN_PERMISSION,
                defaultPermission: ADMIN_DEFAULT,
                argumentVariants: namedCoordinateVariants
            },
            delete: admin('Delete a waypoint by name', [name]),
            rename: admin('Rename a waypoint', [name, newName]),
            relocate: {
                description: 'Move a waypoint to your position or explicit coordinates',
                permission: ADMIN_PERMISSION,
                defaultPermission: ADMIN_DEFAULT,
                argumentVariants: namedCoordinateVariants
            },
            list: { description: 'List enabled waypoints you can access' },
            info: { description: 'Show details for an enabled waypoint you can access', arguments: [name] },
            teleport: {
                description: 'Teleport to a waypoint or, as an operator, teleport selected players',
                argumentVariants: teleportVariants
            },
            tp: {
                description: 'Alias for teleport',
                argumentVariants: teleportVariants
            },
            enable: admin('Enable a waypoint', [name]),
            disable: admin('Disable a waypoint', [name]),
            get: admin('Inspect a waypoint, including disabled records', [name]),
            access: {
                description: 'Manage waypoint access',
                subcommands: {
                    public: admin('Allow every player to access a waypoint', [name]),
                    restricted: admin('Restrict a waypoint to its grants', [name]),
                    list: admin('List a waypoint access mode and its grants', [name]),
                    grant: {
                        description: 'Add an access grant',
                        subcommands: {
                            player: admin('Grant access to an online player', [name, player]),
                            permission: admin('Grant access to a permission node', [name, permission]),
                            group: admin('Grant access to a permission marker group', [name, group])
                        }
                    },
                    revoke: {
                        description: 'Remove an access grant',
                        subcommands: {
                            player: admin('Revoke an online player grant', [name, player]),
                            permission: admin('Revoke a permission node grant', [name, permission]),
                            group: admin('Revoke a permission marker group grant', [name, group])
                        }
                    }
                }
            },
            set: {
                description: 'Set waypoint metadata',
                subcommands: {
                    color: admin('Set the waypoint color', [name, hex]),
                    icon: admin('Set the waypoint item icon', [name, item]),
                    label: admin('Set the waypoint display label', [name, label]),
                    description: admin('Set the waypoint description', [name, description]),
                    'visibility-range': admin('Set the waypoint rendering range in blocks', [
                        name,
                        { name: 'range', type: 'double', min: Number.MIN_VALUE, max: 30_000_000 }
                    ])
                }
            },
            reset: admin('Reset one mutable waypoint property to its default', [
                name,
                { name: 'property', type: 'string', mode: 'single-word' }
            ])
        }
    }
});
