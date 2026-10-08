import type { CommandSender } from 'pumpkin:plugin/command@0.1.0';
import type { Player, Uuid } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { type CommandHandlers, type CommandLine, errorLine } from '@pumpkin-plugins/docs';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { PLUGIN_NAME } from '../name';
import { canAccessWaypoint } from '../waypoints/access';
import type { MutationResult, WaypointCatalog } from '../waypoints/catalog.ts';
import { type AccessGrant, normalizeColor, type Waypoint, waypointNameKey } from '../waypoints/model';
import type { commands } from './spec.ts';

const OPERATOR_ONLY = 'Only server operators can manage waypoints.';
const PLAYER_ONLY = 'This command can only be used by a player.';
const INACCESSIBLE = 'Waypoint not found or you do not have access.';
const STORAGE_ERROR =
    'Waypoint storage is unavailable or the change could not be saved; check the server log. No changes were made.';

/** Host APIs and canonical data used by command handlers. */
export interface WaypointCommandRuntime {
    readonly server: Server;
    readonly catalog: WaypointCatalog;
    createWaypointId(): string;
    uuidToString(id: Uuid): string;
    uuidFromString(id: string): Uuid | undefined;
    consumePendingItemIconInput?(sender: CommandSender): string | undefined;
    /** Checks an item key against Pumpkin's item registry without persisting an item stack. */
    validateItemIcon(key: string): boolean;
}

interface Actor {
    readonly player: Player;
    readonly playerId: string;
    readonly isOperator: boolean;
    hasPermission(node: string): boolean;
}

/** Builds handlers whose names and values are inferred from the shared command declaration. */
export function commandHandlers(runtime: WaypointCommandRuntime): CommandHandlers<typeof commands, CommandSender> {
    return {
        'wp create': () => [errorLine('Usage: /wp create <name> [<x> <y> <z>].')],
        'wp create <name>': (sender, { name }) =>
            withOperator(runtime, sender, (actor) =>
                withCurrentLocation(actor, (dimension, position) =>
                    mutationLines(
                        runtime.catalog.create({ id: runtime.createWaypointId(), name, dimension, position }),
                        `Created waypoint ${name}.`
                    )
                )
            ),
        'wp create <name> <x> <y> <z>': (sender, { name, x, y, z }) =>
            withOperator(runtime, sender, (actor) =>
                withWorldName(actor, (dimension) =>
                    mutationLines(
                        runtime.catalog.create({
                            id: runtime.createWaypointId(),
                            name,
                            dimension,
                            position: { x, y, z }
                        }),
                        `Created waypoint ${name}.`
                    )
                )
            ),
        'wp delete <name>': (sender, { name }) =>
            withOperator(runtime, sender, () =>
                mutationLines(runtime.catalog.remove(name), `Deleted waypoint ${name}.`)
            ),
        'wp rename <name> <newName>': (sender, { name, newName }) =>
            withOperator(runtime, sender, () =>
                mutationLines(runtime.catalog.rename(name, newName), `Renamed waypoint ${name} to ${newName}.`)
            ),
        'wp relocate': () => [errorLine('Usage: /wp relocate <name> [<x> <y> <z>].')],
        'wp relocate <name>': (sender, { name }) =>
            withOperator(runtime, sender, (actor) =>
                withCurrentLocation(actor, (dimension, position) =>
                    mutationLines(runtime.catalog.relocate(name, dimension, position), `Relocated waypoint ${name}.`)
                )
            ),
        'wp relocate <name> <x> <y> <z>': (sender, { name, x, y, z }) =>
            withOperator(runtime, sender, (actor) =>
                withWorldName(actor, (dimension) =>
                    mutationLines(runtime.catalog.relocate(name, dimension, { x, y, z }), `Relocated waypoint ${name}.`)
                )
            ),
        'wp list': (sender) =>
            withActor(runtime, sender, (actor) => {
                if (!runtime.catalog.isAvailable) return [errorLine(STORAGE_ERROR)];
                const waypoints = runtime.catalog
                    .list()
                    .filter((waypoint) => waypoint.enabled && canAccessWaypoint(waypoint, actor))
                    .sort((left, right) => waypointNameKey(left.name).localeCompare(waypointNameKey(right.name)));
                return waypoints.length === 0 ? ['No accessible waypoints.'] : waypoints.map(formatSummary);
            }),
        'wp info <name>': (sender, { name }) =>
            withActor(runtime, sender, (actor) => {
                const waypoint = accessibleWaypoint(runtime, actor, name);
                return waypoint === undefined ? [errorLine(INACCESSIBLE)] : [formatInfo(waypoint)];
            }),
        'wp teleport': () => [errorLine('Usage: /wp teleport <name> [<targets>].')],
        'wp teleport <name>': (sender, { name }) => teleportSelf(runtime, sender, name),
        'wp teleport <name> <targets>': (sender, { name, targets }) => teleportTargets(runtime, sender, name, targets),
        'wp tp': () => [errorLine('Usage: /wp tp <name> [<targets>].')],
        'wp tp <name>': (sender, { name }) => teleportSelf(runtime, sender, name),
        'wp tp <name> <targets>': (sender, { name, targets }) => teleportTargets(runtime, sender, name, targets),
        'wp enable <name>': (sender, { name }) =>
            withOperator(runtime, sender, () =>
                mutationLines(runtime.catalog.setEnabled(name, true), `Enabled waypoint ${name}.`)
            ),
        'wp disable <name>': (sender, { name }) =>
            withOperator(runtime, sender, () =>
                mutationLines(runtime.catalog.setEnabled(name, false), `Disabled waypoint ${name}.`)
            ),
        'wp get <name>': (sender, { name }) =>
            withOperator(runtime, sender, () => {
                if (!runtime.catalog.isAvailable) return [errorLine(STORAGE_ERROR)];
                const waypoint = runtime.catalog.getByName(name);
                return waypoint === undefined ? [errorLine('Waypoint not found.')] : [formatAdminDetails(waypoint)];
            }),
        'wp access public <name>': (sender, { name }) =>
            updateAccess(
                runtime,
                sender,
                name,
                (access) => ({
                    ...access,
                    mode: 'public'
                }),
                'Waypoint is public.'
            ),
        'wp access restricted <name>': (sender, { name }) =>
            updateAccess(
                runtime,
                sender,
                name,
                (access) => ({
                    ...access,
                    mode: 'restricted'
                }),
                'Waypoint is restricted.'
            ),
        'wp access list <name>': (sender, { name }) =>
            withOperator(runtime, sender, () => {
                const waypoint = runtime.catalog.getByName(name);
                if (waypoint === undefined) return [errorLine('Waypoint not found.')];
                return [
                    `Access mode: ${waypoint.access.mode}.`,
                    ...(waypoint.access.grants.length === 0 ? ['No grants.'] : waypoint.access.grants.map(formatGrant))
                ];
            }),
        'wp access grant player <name> <player>': (sender, { name, player }) =>
            withOperator(runtime, sender, () =>
                withOnlinePlayer(runtime, player, (target) =>
                    updateGrant(
                        runtime,
                        name,
                        { type: 'player', playerId: runtime.uuidToString(target.getId()).toLowerCase() },
                        true
                    )
                )
            ),
        'wp access grant permission <name> <permission>': (sender, { name, permission }) =>
            withOperator(runtime, sender, () =>
                updateGrant(runtime, name, { type: 'permission', node: permission }, true)
            ),
        'wp access grant group <name> <group>': (sender, { name, group }) =>
            withOperator(runtime, sender, () => updateGrant(runtime, name, { type: 'group', slug: group }, true)),
        'wp access revoke player <name> <player>': (sender, { name, player }) =>
            withOperator(runtime, sender, () =>
                withOnlinePlayer(runtime, player, (target) =>
                    updateGrant(
                        runtime,
                        name,
                        { type: 'player', playerId: runtime.uuidToString(target.getId()).toLowerCase() },
                        false
                    )
                )
            ),
        'wp access revoke permission <name> <permission>': (sender, { name, permission }) =>
            withOperator(runtime, sender, () =>
                updateGrant(runtime, name, { type: 'permission', node: permission }, false)
            ),
        'wp access revoke group <name> <group>': (sender, { name, group }) =>
            withOperator(runtime, sender, () => updateGrant(runtime, name, { type: 'group', slug: group }, false)),
        'wp set color <name> <hex>': (sender, { name, hex }) =>
            withOperator(runtime, sender, () => {
                let color: string;
                try {
                    color = normalizeColor(hex);
                } catch {
                    return [errorLine('Use six hexadecimal digits, optionally prefixed with #.')];
                }
                return mutationLines(runtime.catalog.update(name, { color }), `Updated color for ${name}.`);
            }),
        'wp set icon <name> <item>': (sender, { name, item }) =>
            withOperator(runtime, sender, () => {
                const pendingInput = runtime.consumePendingItemIconInput?.(sender);
                const itemIdentifier = item || pendingInput || '';
                if (itemIdentifier === '') {
                    return [errorLine('Pumpkin did not pass the selected item identifier to the plugin.')];
                }
                let valid = false;
                try {
                    valid = runtime.validateItemIcon(itemIdentifier);
                } catch {
                    valid = false;
                }
                return valid
                    ? mutationLines(runtime.catalog.update(name, { icon: itemIdentifier }), `Updated icon for ${name}.`)
                    : [errorLine('That item identifier is not present in the server item registry.')];
            }),
        'wp set label <name> <label>': (sender, { name, label }) =>
            withOperator(runtime, sender, () =>
                mutationLines(runtime.catalog.update(name, { label }), `Updated label for ${name}.`)
            ),
        'wp set description <name> <description>': (sender, { name, description }) =>
            withOperator(runtime, sender, () =>
                mutationLines(runtime.catalog.update(name, { description }), `Updated description for ${name}.`)
            ),
        'wp set visibility-range <name> <range>': (sender, { name, range }) =>
            withOperator(runtime, sender, () =>
                mutationLines(
                    runtime.catalog.update(name, { visibilityRange: range }),
                    `Updated visibility range for ${name}.`
                )
            ),
        'wp reset <name> <property>': (sender, { name, property }) =>
            withOperator(runtime, sender, () => resetProperty(runtime, name, property))
    };
}

function withActor(
    runtime: WaypointCommandRuntime,
    sender: CommandSender,
    run: (actor: Actor) => readonly CommandLine[]
): CommandLine[] {
    const player = sender.asPlayer() ?? undefined;
    if (player === undefined) return [errorLine(PLAYER_ONLY)];
    try {
        const id = player.getId();
        const opManager = runtime.server.getOpManager();
        let isOperator: boolean;
        try {
            isOperator = opManager.isOp(id);
        } finally {
            disposeWasiResource(opManager);
        }
        const actor: Actor = {
            player,
            playerId: runtime.uuidToString(id).toLowerCase(),
            isOperator,
            hasPermission: (node) => player.hasPermission(node)
        };
        return [...run(actor)];
    } finally {
        disposeWasiResource(player);
    }
}

function withOperator(
    runtime: WaypointCommandRuntime,
    sender: CommandSender,
    run: (actor: Actor) => readonly CommandLine[]
): CommandLine[] {
    return withActor(runtime, sender, (actor) => (actor.isOperator ? run(actor) : [errorLine(OPERATOR_ONLY)]));
}

function withCurrentLocation(
    actor: Actor,
    run: (dimension: string, position: Waypoint['position']) => readonly CommandLine[]
): CommandLine[] {
    const [x, y, z] = actor.player.getPosition();
    return withWorldName(actor, (dimension) => run(dimension, { x, y, z }));
}

function withWorldName(actor: Actor, run: (dimension: string) => readonly CommandLine[]): CommandLine[] {
    const world = actor.player.getWorld();
    try {
        return [...run(world.getName())];
    } finally {
        disposeWasiResource(world);
    }
}

function mutationLines(result: MutationResult, success: string): CommandLine[] {
    if (result.status === 'created' || result.status === 'updated' || result.status === 'removed') return [success];
    if (result.status === 'not-found') return [errorLine(INACCESSIBLE)];
    if (result.status === 'conflict') return [errorLine('A waypoint with that name already exists.')];
    if (result.status === 'invalid') return [errorLine('The waypoint data is invalid.')];
    return [errorLine(STORAGE_ERROR)];
}

function accessibleWaypoint(runtime: WaypointCommandRuntime, actor: Actor, name: string): Waypoint | undefined {
    if (!runtime.catalog.isAvailable) return undefined;
    const waypoint = runtime.catalog.getByName(name);
    return waypoint?.enabled && canAccessWaypoint(waypoint, actor) ? waypoint : undefined;
}

function formatSummary(waypoint: Waypoint): string {
    return `${waypoint.label ?? waypoint.name} — ${waypoint.dimension} (${Math.round(waypoint.position.x)}, ${Math.round(waypoint.position.y)}, ${Math.round(waypoint.position.z)})`;
}

function formatInfo(waypoint: Waypoint): string {
    const lines = [
        `${waypoint.label ?? waypoint.name} — ${waypoint.dimension}`,
        `Position: ${waypoint.position.x}, ${waypoint.position.y}, ${waypoint.position.z}`
    ];
    if (waypoint.description !== undefined) lines.push(waypoint.description);
    return lines.join('\n');
}

function formatAdminDetails(waypoint: Waypoint): string {
    return [
        `Waypoint ${waypoint.name} (${waypoint.id})`,
        `${waypoint.dimension}: ${waypoint.position.x}, ${waypoint.position.y}, ${waypoint.position.z}`,
        `Enabled: ${waypoint.enabled}; access: ${waypoint.access.mode}; color: ${waypoint.color}`,
        `Label: ${waypoint.label ?? '(unset)'}; description: ${waypoint.description ?? '(unset)'}`,
        `Icon: ${waypoint.icon ?? '(unset)'}; visibility range: ${waypoint.visibilityRange ?? '(unlimited)'}`,
        ...(waypoint.access.grants.length === 0 ? ['Grants: (none)'] : waypoint.access.grants.map(formatGrant))
    ].join('\n');
}

function formatGrant(grant: AccessGrant): string {
    if (grant.type === 'player') return `player: ${grant.playerId}`;
    if (grant.type === 'permission') return `permission: ${grant.node}`;
    return `group marker: ${PLUGIN_NAME}:group.${grant.slug}`;
}

function updateAccess(
    runtime: WaypointCommandRuntime,
    sender: CommandSender,
    name: string,
    update: (current: Waypoint['access']) => Waypoint['access'],
    success: string
): CommandLine[] {
    return withOperator(runtime, sender, () => {
        const waypoint = runtime.catalog.getByName(name);
        if (waypoint === undefined) return [errorLine('Waypoint not found.')];
        return mutationLines(runtime.catalog.update(name, { access: update(waypoint.access) }), success);
    });
}

function updateGrant(runtime: WaypointCommandRuntime, name: string, grant: AccessGrant, add: boolean): CommandLine[] {
    const waypoint = runtime.catalog.getByName(name);
    if (waypoint === undefined) return [errorLine('Waypoint not found.')];
    const key = grantKey(grant);
    const current = waypoint.access.grants;
    const grants = add
        ? current.some((entry) => grantKey(entry) === key)
            ? [...current]
            : [...current, grant]
        : current.filter((entry) => grantKey(entry) !== key);
    return mutationLines(
        runtime.catalog.update(name, { access: { ...waypoint.access, grants } }),
        add ? 'Access grant added.' : 'Access grant removed.'
    );
}

function grantKey(grant: AccessGrant): string {
    if (grant.type === 'player') return `player:${grant.playerId.toLowerCase()}`;
    if (grant.type === 'permission') return `permission:${grant.node}`;
    return `group:${grant.slug}`;
}

function withOnlinePlayer<T extends readonly CommandLine[]>(
    runtime: WaypointCommandRuntime,
    name: string,
    run: (player: Player) => T
): CommandLine[] {
    const player = runtime.server.getPlayerByName(name) ?? undefined;
    if (player === undefined) return [errorLine('That player must be online.')];
    try {
        return [...run(player)];
    } finally {
        disposeWasiResource(player);
    }
}

function resetProperty(runtime: WaypointCommandRuntime, name: string, property: string): CommandLine[] {
    const patches: Record<string, Partial<Waypoint>> = {
        color: { color: '#FFFFFF' },
        icon: { icon: undefined },
        label: { label: undefined },
        description: { description: undefined },
        'visibility-range': { visibilityRange: undefined },
        enabled: { enabled: true },
        access: { access: { mode: 'restricted', grants: [] } }
    };
    const patch = patches[property];
    if (patch === undefined) return [errorLine('That property cannot be reset.')];
    return mutationLines(runtime.catalog.update(name, patch), `Reset ${property} for ${name}.`);
}

function teleportSelf(runtime: WaypointCommandRuntime, sender: CommandSender, name: string): CommandLine[] {
    return withActor(runtime, sender, (actor) => {
        const waypoint = accessibleWaypoint(runtime, actor, name);
        if (waypoint === undefined) return [errorLine(INACCESSIBLE)];
        return withDestination(runtime, waypoint, (world) => {
            try {
                actor.player.teleport(
                    [waypoint.position.x, waypoint.position.y, waypoint.position.z],
                    actor.player.getYaw(),
                    actor.player.getPitch(),
                    world
                );
                return [`Teleported to ${waypoint.name}.`];
            } catch {
                return [errorLine('The server could not teleport you to that waypoint.')];
            }
        });
    });
}

function teleportTargets(
    runtime: WaypointCommandRuntime,
    sender: CommandSender,
    name: string,
    targets: readonly { readonly id: string; readonly name: string }[]
): CommandLine[] {
    return withOperator(runtime, sender, (actor) => {
        const waypoint = accessibleWaypoint(runtime, actor, name);
        if (waypoint === undefined) return [errorLine(INACCESSIBLE)];
        if (targets.length === 0) return [errorLine('The selector did not match any online players.')];

        const resolved: Player[] = [];
        try {
            for (const target of targets) {
                const targetUuid = runtime.uuidFromString(target.id);
                if (targetUuid === undefined) return [errorLine('One or more selected players are no longer online.')];
                const player = runtime.server.getPlayerByUuid(targetUuid) ?? undefined;
                if (
                    player === undefined ||
                    runtime.uuidToString(player.getId()).toLowerCase() !== target.id.toLowerCase()
                ) {
                    if (player !== undefined) disposeWasiResource(player);
                    return [errorLine('One or more selected players are no longer online.')];
                }
                resolved.push(player);
            }
            return withDestination(runtime, waypoint, (world) => {
                try {
                    for (const target of resolved) {
                        target.teleport(
                            [waypoint.position.x, waypoint.position.y, waypoint.position.z],
                            target.getYaw(),
                            target.getPitch(),
                            world
                        );
                    }
                    return [
                        `Teleported ${resolved.length} player${resolved.length === 1 ? '' : 's'} to ${waypoint.name}.`
                    ];
                } catch {
                    return [errorLine('The server could not teleport every selected player.')];
                }
            });
        } finally {
            for (const player of resolved) disposeWasiResource(player);
        }
    });
}

function withDestination(
    runtime: WaypointCommandRuntime,
    waypoint: Waypoint,
    run: (world: NonNullable<ReturnType<Server['getWorldByName']>>) => readonly CommandLine[]
): CommandLine[] {
    const world = runtime.server.getWorldByName(waypoint.dimension) ?? undefined;
    if (world === undefined) return [errorLine('The waypoint dimension is not currently available.')];
    try {
        if (waypoint.position.y < world.getMinY())
            return [errorLine('The waypoint is below the dimension build limit.')];
        return [...run(world)];
    } catch {
        return [errorLine('The server could not use the waypoint destination.')];
    } finally {
        disposeWasiResource(world);
    }
}
