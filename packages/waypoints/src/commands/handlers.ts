import type { CommandSender } from 'pumpkin:plugin/command@0.1.0';
import type { Player, Uuid } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { type CommandHandlers, type CommandLine, errorLine } from '@pumpkin-plugins/docs';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import type { MapDeliveryService, MapRecipient } from '../adapters/map-delivery.ts';
import type { Waypoint, WaypointVisibility } from '../waypoints/model.ts';
import type { WaypointActor, WaypointMutationResult, WaypointService } from '../waypoints/service.ts';
import { ADMIN_PERMISSION, type commands } from './spec.ts';

/** Host and domain services used by the typed command handlers. */
export interface WaypointCommandRuntime {
    readonly server: Server;
    readonly waypoints: WaypointService;
    readonly mapDelivery: MapDeliveryService;
    /** Generates a UUID through Pumpkin's pinned UUID interface. */
    createWaypointId(): string;
    /** Converts Pumpkin UUID records to canonical strings. */
    uuidToString(id: Uuid): string;
    /** Sends one-to-one readable fallback text to a player. */
    sendSystemMessage(player: Player, message: string): void;
}

/** Builds handlers whose keys and argument values are inferred from the shared command declaration. */
export function commandHandlers(runtime: WaypointCommandRuntime): CommandHandlers<typeof commands, CommandSender> {
    return {
        'wp mark <name>': (sender, { name }) =>
            withActor(runtime, sender, ({ actor, player }) => {
                if (player === undefined) return playerOnly();
                const [x, y, z] = player.getPosition();
                const dimension = worldName(player);
                return mutationLines(
                    runtime.waypoints.create(actor, {
                        id: runtime.createWaypointId(),
                        name,
                        dimension,
                        x,
                        y,
                        z
                    }),
                    `Created waypoint ${name}`
                );
            }),
        'wp add <name> <x> <y> <z>': (sender, { name, x, y, z }) =>
            withActor(runtime, sender, ({ actor, player }) => {
                if (player === undefined) return playerOnly();
                return mutationLines(
                    runtime.waypoints.create(actor, {
                        id: runtime.createWaypointId(),
                        name,
                        dimension: worldName(player),
                        x,
                        y,
                        z
                    }),
                    `Created waypoint ${name}`
                );
            }),
        'wp list': (sender) => listWaypoints(runtime, sender),
        'wp list <scope>': (sender, { scope }) => {
            if (scope !== 'all') return [errorLine('Use /wp list or /wp list all.')];
            return listWaypoints(runtime, sender, true);
        },
        'wp show <id>': (sender, { id }) =>
            withActor(runtime, sender, ({ actor }) => {
                const waypoint = runtime.waypoints.getFor(actor, id);
                return waypoint === undefined ? inaccessible() : [formatWaypointDetails(waypoint)];
            }),
        'wp access public <id>': (sender, { id }) => setVisibility(runtime, sender, id, 'public'),
        'wp access private <id>': (sender, { id }) => setVisibility(runtime, sender, id, 'private'),
        'wp access allowlist <id>': (sender, { id }) => setVisibility(runtime, sender, id, 'allowlist'),
        'wp access invite <id> <player>': (sender, { id, player: playerName }) =>
            withActor(runtime, sender, ({ actor }) =>
                withOnlinePlayer(runtime, playerName, (recipient) =>
                    mutationLines(
                        runtime.waypoints.addRecipient(actor, id, runtime.uuidToString(recipient.getId())),
                        'Updated waypoint access'
                    )
                )
            ),
        'wp access revoke <id> <player>': (sender, { id, player: playerName }) =>
            withActor(runtime, sender, ({ actor }) =>
                withOnlinePlayer(runtime, playerName, (recipient) =>
                    mutationLines(
                        runtime.waypoints.removeRecipient(actor, id, runtime.uuidToString(recipient.getId())),
                        'Updated waypoint access'
                    )
                )
            ),
        'wp locator on <id>': (sender, { id }) => setLocatorEnabled(runtime, sender, id, true),
        'wp locator off <id>': (sender, { id }) => setLocatorEnabled(runtime, sender, id, false),
        'wp locator color <id> <hex>': (sender, { id, hex }) =>
            withActor(runtime, sender, ({ actor }) => {
                const color = hex === 'reset' ? undefined : normalizeColor(hex);
                if (color === INVALID_COLOR)
                    return [errorLine('Use six hexadecimal digits, optionally prefixed with #, or reset.')];
                return mutationLines(runtime.waypoints.setLocatorColor(actor, id, color), 'Updated locator color');
            }),
        'wp locator java-style <id> <style>': (sender, { id, style }) =>
            withActor(runtime, sender, ({ actor }) =>
                mutationLines(
                    runtime.waypoints.setJavaStyle(actor, id, style === 'reset' ? undefined : style),
                    'Updated Java locator style'
                )
            ),
        'wp remove <id>': (sender, { id }) =>
            withActor(runtime, sender, ({ actor }) =>
                mutationLines(runtime.waypoints.remove(actor, id), 'Removed waypoint')
            ),
        'wp send <id> <adapter>': (sender, { id, adapter }) =>
            withActor(runtime, sender, ({ actor, player }) => {
                if (player === undefined) return playerOnly();
                const waypoint = runtime.waypoints.getFor(actor, id);
                if (waypoint === undefined) return inaccessible();
                const recipient = mapRecipient(runtime, player, actor);
                return mapDeliveryLines(runtime.mapDelivery.send(actor, recipient, id, adapter), waypoint, false);
            }),
        'wp send-to <id> <player> <adapter>': (sender, { id, player: playerName, adapter }) =>
            withActor(runtime, sender, ({ actor }) => {
                const waypoint = runtime.waypoints.getFor(actor, id);
                if (waypoint === undefined) return inaccessible();
                return withOnlinePlayer(runtime, playerName, (player) => {
                    const recipientActor: WaypointActor = {
                        playerId: runtime.uuidToString(player.getId()),
                        isOperator: player.hasPermission(ADMIN_PERMISSION)
                    };
                    const recipient = mapRecipient(runtime, player, recipientActor);
                    const result = runtime.mapDelivery.send(actor, recipient, id, adapter);
                    if (result.status === 'not-found') return inaccessible();
                    if (result.status === 'unavailable' || result.status === 'delivered') {
                        runtime.sendSystemMessage(player, formatWaypoint(waypoint));
                    }
                    return mapDeliveryLines(result, waypoint, true);
                });
            }),
        'wp admin list': (sender) =>
            withActor(runtime, sender, ({ actor }) => {
                const waypoints = runtime.waypoints.listAll(actor);
                if (waypoints === undefined)
                    return [
                        errorLine('This command requires the Waypoints operator permission or an available store.')
                    ];
                return waypoints.length === 0 ? ['No waypoints are saved.'] : waypoints.map(formatWaypointSummary);
            }),
        'wp admin remove <id>': (sender, { id }) =>
            withActor(runtime, sender, ({ actor }) =>
                mutationLines(runtime.waypoints.remove(actor, id), 'Removed waypoint')
            )
    };
}

function listWaypoints(runtime: WaypointCommandRuntime, sender: CommandSender, allDimensions = false): CommandLine[] {
    return withActor(runtime, sender, ({ actor, player }) => {
        if (player === undefined && !allDimensions) return playerOnly();
        const dimension = allDimensions || player === undefined ? undefined : worldName(player);
        const waypoints = runtime.waypoints.listFor(actor, dimension);
        if (waypoints === undefined) return storeUnavailable();
        return waypoints.length === 0 ? ['No accessible waypoints.'] : waypoints.map(formatWaypointSummary);
    });
}

function setVisibility(
    runtime: WaypointCommandRuntime,
    sender: CommandSender,
    id: string,
    visibility: WaypointVisibility
): CommandLine[] {
    return withActor(runtime, sender, ({ actor }) =>
        mutationLines(runtime.waypoints.setVisibility(actor, id, visibility), `Set waypoint access to ${visibility}`)
    );
}

function setLocatorEnabled(
    runtime: WaypointCommandRuntime,
    sender: CommandSender,
    id: string,
    enabled: boolean
): CommandLine[] {
    return withActor(runtime, sender, ({ actor }) =>
        mutationLines(
            runtime.waypoints.setLocatorEnabled(actor, id, enabled),
            `Locator output ${enabled ? 'enabled' : 'disabled'}`
        )
    );
}

function withOnlinePlayer(
    runtime: WaypointCommandRuntime,
    name: string,
    run: (player: Player) => CommandLine[]
): CommandLine[] {
    const player = runtime.server.getPlayerByName(name) ?? undefined;
    if (player === undefined) return [errorLine('That player must be online.')];
    try {
        return run(player);
    } finally {
        disposeWasiResource(player);
    }
}

function withActor(
    runtime: WaypointCommandRuntime,
    sender: CommandSender,
    run: (context: { actor: WaypointActor; player: Player | undefined }) => CommandLine[]
): CommandLine[] {
    const player = sender.asPlayer() ?? undefined;
    try {
        return run({
            actor: {
                playerId: player === undefined ? '' : runtime.uuidToString(player.getId()),
                isOperator: sender.hasPermission(runtime.server, ADMIN_PERMISSION)
            },
            player
        });
    } finally {
        disposeWasiResource(player);
    }
}

function worldName(player: Player): string {
    const world = player.getWorld();
    try {
        return world.getName();
    } finally {
        disposeWasiResource(world);
    }
}

function mapRecipient(runtime: WaypointCommandRuntime, player: Player, actor: WaypointActor): MapRecipient {
    return {
        ...actor,
        sendSystemMessage: (message) => runtime.sendSystemMessage(player, message)
    };
}

function mapDeliveryLines(
    result: ReturnType<MapDeliveryService['send']>,
    waypoint: Waypoint,
    sentToAnotherPlayer: boolean
): CommandLine[] {
    switch (result.status) {
        case 'not-found':
            return inaccessible();
        case 'unsupported':
            return [errorLine(result.reason)];
        case 'unavailable':
            return sentToAnotherPlayer
                ? [`Sent readable waypoint coordinates. Map import is unavailable: ${result.reason}`]
                : [formatWaypoint(waypoint), `Map import is unavailable: ${result.reason}`];
        case 'delivered':
            return [`Waypoint sent: ${formatWaypoint(waypoint)}`];
    }
}

function mutationLines(result: WaypointMutationResult, success: string): CommandLine[] {
    switch (result) {
        case 'created':
        case 'updated':
        case 'removed':
            return [`${success}.`];
        case 'not-found':
            return inaccessible();
        case 'unavailable':
            return storeUnavailable();
        case 'conflict':
            return [errorLine('Could not save the waypoint because its generated UUID already exists.')];
        case 'invalid':
            return [errorLine('The waypoint value is invalid.')];
    }
}

function formatWaypointSummary(waypoint: Waypoint): string {
    return `${waypoint.name} [${waypoint.id}] — ${waypoint.dimension} ${waypoint.x}, ${waypoint.y}, ${waypoint.z} (${waypoint.visibility})`;
}

function formatWaypoint(waypoint: Waypoint): string {
    return `${waypoint.name} [${waypoint.id}] — ${waypoint.dimension} at ${waypoint.x}, ${waypoint.y}, ${waypoint.z}`;
}

function formatWaypointDetails(waypoint: Waypoint): string {
    return `${formatWaypoint(waypoint)}; owner ${waypoint.ownerId}; access ${waypoint.visibility}.`;
}

function inaccessible(): CommandLine[] {
    return [errorLine('Waypoint not found or you do not have access.')];
}

function playerOnly(): CommandLine[] {
    return [errorLine('This command can only be used by a player.')];
}

function storeUnavailable(): CommandLine[] {
    return [
        errorLine(
            'Waypoint storage is unavailable or the change could not be saved; check the server log. No changes were made.'
        )
    ];
}

const INVALID_COLOR = Symbol('invalid-color');

function normalizeColor(value: string): string | typeof INVALID_COLOR {
    const color = value.startsWith('#') ? value : `#${value}`;
    return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : INVALID_COLOR;
}
