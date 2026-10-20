import type { CommandSender } from 'pumpkin:plugin/command@0.1.0';
import type { Player, Uuid } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { type CommandHandlers, type CommandLine, errorLine } from '@pumpkin-plugins/docs';
import type { CommandSuggestionHandler } from '@pumpkin-plugins/plugin-kit/commands';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { PLUGIN_NAME } from '../name.ts';
import { canAccessWaypoint } from '../waypoints/access.ts';
import type { MutationResult, WaypointCatalog, WaypointMetadataPatch } from '../waypoints/catalog.ts';
import {
    type AccessGrant,
    grantKey,
    normalizeColor,
    WAYPOINT_METADATA_DEFAULTS,
    type Waypoint,
    type WaypointMetadataKey,
    waypointNameKey,
} from '../waypoints/model.ts';
import { ADMIN_PERMISSION, type commands } from './spec.ts';

const NOT_ADMIN = 'You do not have permission to manage waypoints.';
const PLAYER_ONLY = 'This command can only be used by a player.';
const INACCESSIBLE = 'Waypoint not found or you do not have access.';
const CREATE_INPUT = /^\s*\/?wp\s+create\s/i;
const REVOKE_PLAYER_INPUT = /^\/?wp\s+access\s+revoke\s+player\s+("(?:[^"\\]|\\.)*"|\S+)\s/i;
const STORAGE_ERROR =
    'Waypoint storage is unavailable or the change could not be saved; check the server log. No changes were made.';
/** Host APIs and canonical data used by command handlers. */
export interface WaypointCommandRuntime {
    readonly catalog: WaypointCatalog;
    consumePendingItemIconInput?(sender: CommandSender): string | undefined;
    createWaypointId(): string;
    readonly server: Server;
    uuidFromString(id: string): Uuid | undefined;
    uuidToString(id: Uuid): string;
    /** Checks an item key against Pumpkin's item registry without persisting an item stack. */
    validateItemIcon(key: string): boolean;
}

interface Actor {
    hasPermission(node: string): boolean;
    readonly isOperator: boolean;
    readonly player: Player;
    readonly playerId: string;
}

/** Builds handlers whose names and values are inferred from the shared command declaration. */
export function commandHandlers(runtime: WaypointCommandRuntime): CommandHandlers<typeof commands, CommandSender> {
    return {
        'wp reload': (sender) => withAdmin(runtime, sender, () => reloadLines(runtime)),
        'wp create': () => [errorLine('Usage: /wp create <name> [<x> <y> <z>].')],
        'wp create <name>': (sender, { name }) =>
            withAdminPlayer(runtime, sender, (actor) =>
                withCurrentLocation(actor, (dimension, position) =>
                    mutationLines(
                        runtime.catalog.create({ id: runtime.createWaypointId(), name, dimension, position }),
                        `Created waypoint ${name}.`,
                    ),
                ),
            ),
        'wp create <name> <x> <y> <z>': (sender, { name, x, y, z }) =>
            withAdminPlayer(runtime, sender, (actor) =>
                withWorldName(actor, (dimension) =>
                    mutationLines(
                        runtime.catalog.create({
                            id: runtime.createWaypointId(),
                            name,
                            dimension,
                            position: { x, y, z },
                        }),
                        `Created waypoint ${name}.`,
                    ),
                ),
            ),
        'wp delete <name>': (sender, { name }) =>
            withAdmin(runtime, sender, () => mutationLines(runtime.catalog.remove(name), `Deleted waypoint ${name}.`)),
        'wp rename <name> <newName>': (sender, { name, newName }) =>
            withAdmin(runtime, sender, () =>
                mutationLines(runtime.catalog.rename(name, newName), `Renamed waypoint ${name} to ${newName}.`),
            ),
        'wp relocate': () => [errorLine('Usage: /wp relocate <name> [<x> <y> <z>].')],
        'wp relocate <name>': (sender, { name }) =>
            withAdminPlayer(runtime, sender, (actor) =>
                withCurrentLocation(actor, (dimension, position) =>
                    mutationLines(runtime.catalog.relocate(name, dimension, position), `Relocated waypoint ${name}.`),
                ),
            ),
        'wp relocate <name> <x> <y> <z>': (sender, { name, x, y, z }) =>
            withAdminPlayer(runtime, sender, (actor) =>
                withWorldName(actor, (dimension) =>
                    mutationLines(
                        runtime.catalog.relocate(name, dimension, { x, y, z }),
                        `Relocated waypoint ${name}.`,
                    ),
                ),
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
            withAdmin(runtime, sender, () =>
                mutationLines(runtime.catalog.setEnabled(name, true), `Enabled waypoint ${name}.`),
            ),
        'wp disable <name>': (sender, { name }) =>
            withAdmin(runtime, sender, () =>
                mutationLines(runtime.catalog.setEnabled(name, false), `Disabled waypoint ${name}.`),
            ),
        'wp get <name>': (sender, { name }) =>
            withAdmin(runtime, sender, () => {
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
                    mode: 'public',
                }),
                'Waypoint is public.',
            ),
        'wp access restricted <name>': (sender, { name }) =>
            updateAccess(
                runtime,
                sender,
                name,
                (access) => ({
                    ...access,
                    mode: 'restricted',
                }),
                'Waypoint is restricted.',
            ),
        'wp access list <name>': (sender, { name }) =>
            withAdmin(runtime, sender, () => {
                if (!runtime.catalog.isAvailable) return [errorLine(STORAGE_ERROR)];
                const waypoint = runtime.catalog.getByName(name);
                if (waypoint === undefined) return [errorLine('Waypoint not found.')];
                return [
                    `Access mode: ${waypoint.access.mode}.`,
                    ...(waypoint.access.grants.length === 0 ? ['No grants.'] : waypoint.access.grants.map(formatGrant)),
                ];
            }),
        'wp access grant player <name> <player>': (sender, { name, player }) =>
            withAdmin(runtime, sender, () =>
                withOnlinePlayer(runtime, player, (target) =>
                    updateGrant(
                        runtime,
                        name,
                        { type: 'player', playerId: runtime.uuidToString(target.getId()).toLowerCase() },
                        true,
                    ),
                ),
            ),
        'wp access grant permission <name> <permission>': (sender, { name, permission }) =>
            withAdmin(runtime, sender, () =>
                updateGrant(runtime, name, { type: 'permission', node: permission }, true),
            ),
        'wp access grant group <name> <group>': (sender, { name, group }) =>
            withAdmin(runtime, sender, () => updateGrant(runtime, name, { type: 'group', slug: group }, true)),
        'wp access revoke player <name> <player>': (sender, { name, player }) =>
            withAdmin(runtime, sender, () => {
                // An offline player can only be named by UUID, which `/wp access list` shows.
                if (runtime.uuidFromString(player) !== undefined) {
                    return updateGrant(runtime, name, { type: 'player', playerId: player.toLowerCase() }, false);
                }
                return withOnlinePlayer(
                    runtime,
                    player,
                    (target) =>
                        updateGrant(
                            runtime,
                            name,
                            { type: 'player', playerId: runtime.uuidToString(target.getId()).toLowerCase() },
                            false,
                        ),
                    'That player is not online; use the UUID shown by /wp access list.',
                );
            }),
        'wp access revoke permission <name> <permission>': (sender, { name, permission }) =>
            withAdmin(runtime, sender, () =>
                updateGrant(runtime, name, { type: 'permission', node: permission }, false),
            ),
        'wp access revoke group <name> <group>': (sender, { name, group }) =>
            withAdmin(runtime, sender, () => updateGrant(runtime, name, { type: 'group', slug: group }, false)),
        'wp set color <name> <hex>': (sender, { name, hex }) =>
            withAdmin(runtime, sender, () => {
                let color: string;
                try {
                    color = normalizeColor(hex);
                } catch {
                    return [errorLine('Use six hexadecimal digits, optionally prefixed with #.')];
                }
                return mutationLines(runtime.catalog.update(name, { color }), `Updated color for ${name}.`);
            }),
        'wp set icon <name> <item>': (sender, { name, item }) =>
            withAdmin(runtime, sender, () => {
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
            withAdmin(runtime, sender, () =>
                mutationLines(runtime.catalog.update(name, { label }), `Updated label for ${name}.`),
            ),
        'wp set description <name> <description>': (sender, { name, description }) =>
            withAdmin(runtime, sender, () =>
                mutationLines(runtime.catalog.update(name, { description }), `Updated description for ${name}.`),
            ),
        'wp set visibility-range <name> <range>': (sender, { name, range }) =>
            withAdmin(runtime, sender, () =>
                mutationLines(
                    runtime.catalog.update(name, { visibilityRange: range }),
                    `Updated visibility range for ${name}.`,
                ),
            ),
        'wp reset <property> <name>': (sender, { property, name }) =>
            withAdmin(runtime, sender, () => resetProperty(runtime, name, property)),
    };
}

/** Suggests waypoint names visible to this sender, using the same access policy as commands. */
export function waypointNameSuggestions(runtime: WaypointCommandRuntime): CommandSuggestionHandler<CommandSender> {
    return (sender, request) => {
        // Every existing name would conflict with a new waypoint.
        if (!runtime.catalog.isAvailable || CREATE_INPUT.test(request.input)) return [];
        const prefix = suggestionPrefix(request.remaining);
        const names = (include: (waypoint: Waypoint) => boolean) =>
            runtime.catalog
                .list()
                .filter((waypoint) => include(waypoint) && waypointNameKey(waypoint.name).startsWith(prefix))
                .sort((left, right) => waypointNameKey(left.name).localeCompare(waypointNameKey(right.name)))
                .map((waypoint) => quoteWaypointName(waypoint.name));
        if (isAdmin(runtime, sender)) return names(() => true);
        return withActorContext(
            runtime,
            sender,
            (actor) => names((waypoint) => waypoint.enabled && canAccessWaypoint(waypoint, actor)),
            () => [],
        );
    };
}

/**
 * Suggests matching online player names to admins managing waypoint access. For a revoke, it also
 * suggests the UUIDs of the waypoint's player grants, so grants of offline players can be removed.
 */
export function onlinePlayerNameSuggestions(runtime: WaypointCommandRuntime): CommandSuggestionHandler<CommandSender> {
    return (sender, request) => {
        if (!isAdmin(runtime, sender)) return [];
        const prefix = suggestionPrefix(request.remaining);
        const players = runtime.server.getAllPlayers();
        let names: string[];
        try {
            names = players.map((player) => player.getName());
        } finally {
            for (const player of players) disposeWasiResource(player);
        }
        return [...names, ...grantedPlayerIds(runtime, request.input)]
            .filter((name) => name.toLowerCase().normalize('NFC').startsWith(prefix))
            .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
    };
}

function grantedPlayerIds(runtime: WaypointCommandRuntime, input: string): string[] {
    const token = REVOKE_PLAYER_INPUT.exec(input.trimStart())?.[1];
    if (token === undefined || !runtime.catalog.isAvailable) return [];
    const name = token.startsWith('"') ? token.slice(1, -1).replace(/\\(["\\])/g, '$1') : token;
    return (runtime.catalog.getByName(name)?.access.grants ?? []).flatMap((grant) =>
        grant.type === 'player' ? [grant.playerId] : [],
    );
}

/** Suggests each property that `/wp reset` can reset, narrowed to the typed prefix. */
export const resetPropertySuggestions: CommandSuggestionHandler<CommandSender> = (_sender, request) => {
    const prefix = suggestionPrefix(request.remaining);
    return Object.keys(WAYPOINT_METADATA_DEFAULTS)
        .map(metadataPropertyName)
        .filter((property) => property.startsWith(prefix))
        .sort((left, right) => left.localeCompare(right));
};

function withActor(
    runtime: WaypointCommandRuntime,
    sender: CommandSender,
    run: (actor: Actor) => readonly CommandLine[],
): CommandLine[] {
    return [...withActorContext(runtime, sender, run, () => [errorLine(PLAYER_ONLY)])];
}

function withActorContext<Result>(
    runtime: WaypointCommandRuntime,
    sender: CommandSender,
    run: (actor: Actor) => Result,
    noPlayer: () => Result,
): Result {
    const player = sender.asPlayer() ?? undefined;
    if (player === undefined) return noPlayer();
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
            hasPermission: (node) => player.hasPermission(node),
        };
        return run(actor);
    } finally {
        disposeWasiResource(player);
    }
}

function suggestionPrefix(remaining: string): string {
    const unquoted = remaining.startsWith('"') ? remaining.slice(1) : remaining;
    return unquoted
        .replace(/\\(["\\])/g, '$1')
        .toLowerCase()
        .normalize('NFC');
}

function metadataPropertyName(property: string): string {
    return property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function quoteWaypointName(name: string): string {
    if (/^[A-Za-z0-9_.+-]+$/.test(name)) return name;
    return `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// Pumpkin grants every permission to the console and RCON, so they pass this check.
function isAdmin(runtime: WaypointCommandRuntime, sender: CommandSender): boolean {
    return sender.hasPermission(runtime.server, ADMIN_PERMISSION);
}

function withAdmin(
    runtime: WaypointCommandRuntime,
    sender: CommandSender,
    run: () => readonly CommandLine[],
): CommandLine[] {
    return isAdmin(runtime, sender) ? [...run()] : [errorLine(NOT_ADMIN)];
}

/** For admin commands that read the sender's position or world. */
function withAdminPlayer(
    runtime: WaypointCommandRuntime,
    sender: CommandSender,
    run: (actor: Actor) => readonly CommandLine[],
): CommandLine[] {
    return withAdmin(runtime, sender, () => withActor(runtime, sender, run));
}

function reloadLines(runtime: WaypointCommandRuntime): CommandLine[] {
    return runtime.catalog.reload()
        ? ['Reloaded waypoints from disk.']
        : [errorLine('Could not reload waypoint data; current data remains active. Check the server log.')];
}

function withCurrentLocation(
    actor: Actor,
    run: (dimension: string, position: Waypoint['position']) => readonly CommandLine[],
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
    if (result.status === 'invalid') return [errorLine(result.reason ?? 'The waypoint data is invalid.')];
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
        `Position: ${waypoint.position.x}, ${waypoint.position.y}, ${waypoint.position.z}`,
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
        ...(waypoint.access.grants.length === 0 ? ['Grants: (none)'] : waypoint.access.grants.map(formatGrant)),
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
    success: string,
): CommandLine[] {
    return withAdmin(runtime, sender, () => {
        if (!runtime.catalog.isAvailable) return [errorLine(STORAGE_ERROR)];
        const waypoint = runtime.catalog.getByName(name);
        if (waypoint === undefined) return [errorLine('Waypoint not found.')];
        return mutationLines(runtime.catalog.update(name, { access: update(waypoint.access) }), success);
    });
}

function updateGrant(runtime: WaypointCommandRuntime, name: string, grant: AccessGrant, add: boolean): CommandLine[] {
    if (!runtime.catalog.isAvailable) return [errorLine(STORAGE_ERROR)];
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
        add ? 'Access grant added.' : 'Access grant removed.',
    );
}

function withOnlinePlayer<T extends readonly CommandLine[]>(
    runtime: WaypointCommandRuntime,
    name: string,
    run: (player: Player) => T,
    offline = 'That player must be online.',
): CommandLine[] {
    const player = runtime.server.getPlayerByName(name) ?? undefined;
    if (player === undefined) return [errorLine(offline)];
    try {
        return [...run(player)];
    } finally {
        disposeWasiResource(player);
    }
}

function resetProperty(runtime: WaypointCommandRuntime, name: string, property: string): CommandLine[] {
    const key = (Object.keys(WAYPOINT_METADATA_DEFAULTS) as WaypointMetadataKey[]).find(
        (metadataProperty) => metadataPropertyName(metadataProperty) === property,
    );
    const patch = key === undefined ? undefined : ({ [key]: WAYPOINT_METADATA_DEFAULTS[key] } as WaypointMetadataPatch);
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
                    world,
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
    targets: readonly { readonly id: string; readonly name: string }[],
): CommandLine[] {
    return withAdminPlayer(runtime, sender, (actor) => {
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
                            world,
                        );
                    }
                    return [
                        `Teleported ${resolved.length} player${resolved.length === 1 ? '' : 's'} to ${waypoint.name}.`,
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
    run: (world: NonNullable<ReturnType<Server['getWorldByName']>>) => readonly CommandLine[],
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
