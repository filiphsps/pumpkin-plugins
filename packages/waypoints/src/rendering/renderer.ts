import type { ClientboundPacket } from 'pumpkin:plugin/java-packets@0.1.0';
import type { Uuid } from 'pumpkin:plugin/uuid@0.1.0';
import type { Waypoint, WaypointPosition } from '../waypoints/model.ts';
import { projectWaypointsForViewer } from '../waypoints/visibility.ts';
import {
    createEntityRemovePacket,
    createTextDisplayAppearancePacket,
    createTextDisplayMetadataPacket,
    createTextDisplayMovement,
    createTextDisplaySpawnPacket
} from './display-protocol.ts';
import { appendWaypointIcon } from './icon-component.ts';
import { placeWaypointHud } from './layout.ts';
import { createWaypointHudTextJson, presentWaypointHud, type WaypointHudPresentation } from './presentation.ts';

export { createWaypointHudTextJson } from './presentation.ts';

const LABEL_ANCHOR_HEIGHT = 2;
const WORLD_STACK_HEIGHT = 0.7;
const FIRST_CLIENT_ENTITY_ID = -1_500_000_000;
const LAST_CLIENT_ENTITY_ID = -2_000_000_000;
const VISUAL_HISTORY_RESET_DISTANCE = 8;

/** Per-viewer inputs required to render one private waypoint display set. */
export interface WaypointHudViewer {
    readonly id: string;
    dimension: string;
    position: WaypointPosition;
    eyePosition: WaypointPosition;
    yaw: number;
    pitch: number;
    readonly isOperator: boolean;
    readonly hasPermission: (node: string) => boolean;
    readonly createEntityUuid: () => Uuid;
    readonly encodeTextComponent: (textJson: string) => Uint8Array;
    readonly sendPacket: (packet: ClientboundPacket) => void;
}

/** Options for the client-only Java waypoint renderer. */
export interface WaypointHudRendererOptions {
    readonly onError?: (viewerId: string, error: unknown) => void;
}

interface DisplayState {
    readonly waypointId: string;
    readonly entityId: number;
    readonly entityUuid: Uuid;
    position: WaypointPosition;
    elevation: number;
    textJson: string | undefined;
    scale: number | undefined;
    opacity: number | undefined;
    presentation: WaypointHudPresentation;
    icon: string | undefined;
    spawned: boolean;
}

interface ViewerState {
    dimension: string;
    eyePosition: WaypointPosition;
    nextEntityId: number;
    readonly displays: Map<string, DisplayState>;
}

/**
 * Renders access-filtered waypoints as client-only Java TextDisplays with directional HUD placement. Each
 * viewer gets an independent entity ledger, so restricted waypoint labels and personalized distances never
 * enter another player's packet stream.
 */
export class WaypointHudRenderer {
    private readonly viewers = new Map<string, ViewerState>();
    private readonly onError: (viewerId: string, error: unknown) => void;

    constructor(options: WaypointHudRendererOptions = {}) {
        this.onError = options.onError ?? (() => undefined);
    }

    /** Renders one viewer's current authorized waypoints and diffs its display packets. */
    renderViewer(viewer: WaypointHudViewer, waypoints: readonly Waypoint[]): void {
        if (
            ![viewer.eyePosition.x, viewer.eyePosition.y, viewer.eyePosition.z, viewer.yaw, viewer.pitch].every(
                Number.isFinite
            )
        )
            return;
        const state = this.viewerState(viewer);
        const resetHistory = distance(state.eyePosition, viewer.eyePosition) > VISUAL_HISTORY_RESET_DISTANCE;
        state.eyePosition = { ...viewer.eyePosition };
        const visible = projectWaypointsForViewer(waypoints, {
            playerId: viewer.id,
            isOperator: viewer.isOperator,
            hasPermission: viewer.hasPermission,
            dimension: viewer.dimension,
            position: viewer.position
        });
        const desired = new Map<string, DesiredDisplay>();
        const stackCounts = new Map<string, number>();
        for (const waypoint of [...visible].sort((left, right) => left.id.localeCompare(right.id))) {
            // Group nearby stored positions, independent of camera yaw and projection/FOV boundaries.
            const stackKey = [waypoint.position.x, waypoint.position.y, waypoint.position.z]
                .map((coordinate) => Math.round(coordinate * 2))
                .join(',');
            const stackIndex = stackCounts.get(stackKey) ?? 0;
            stackCounts.set(stackKey, stackIndex + 1);
            const waypointDistance = distance(viewer.position, waypoint.position);
            // Large sample discontinuities should start at the new bearing, not animate stale elevation/focus.
            const previous = resetHistory ? undefined : state.displays.get(waypoint.id);
            const placement = placeWaypointHud(
                viewer.eyePosition,
                {
                    x: waypoint.position.x,
                    y: waypoint.position.y + LABEL_ANCHOR_HEIGHT + stackIndex * WORLD_STACK_HEIGHT,
                    z: waypoint.position.z
                },
                waypointDistance,
                previous?.elevation,
                stackIndex
            );
            const presentation = presentWaypointHud(viewer, placement, waypointDistance, previous?.presentation);
            desired.set(waypoint.id, {
                ...placement,
                scale: presentation.scale,
                presentation,
                icon: waypoint.icon,
                textJson: createWaypointHudTextJson(waypoint, presentation.distance, presentation.detailed)
            });
        }

        this.removeUndesired(viewer, state, desired);
        for (const [waypointId, display] of desired) {
            try {
                this.syncDisplay(viewer, state, waypointId, display);
            } catch (error) {
                this.report(viewer.id, error);
            }
        }
    }

    /** Removes every client-only display for a player who is leaving or unloading the plugin. */
    removeViewer(viewerId: string, sendPacket: (packet: ClientboundPacket) => void): void {
        const state = this.viewers.get(viewerId);
        if (state === undefined) return;
        const entityIds = [...state.displays.values()].map(({ entityId }) => entityId);
        try {
            if (entityIds.length > 0) sendPacket(createEntityRemovePacket(entityIds));
        } catch (error) {
            this.report(viewerId, error);
        } finally {
            this.viewers.delete(viewerId);
        }
    }

    /** Drops transient state when a client is no longer reachable. */
    forgetViewer(viewerId: string): void {
        this.viewers.delete(viewerId);
    }

    /** Forgets disconnected viewers after a tick without sending packets to a closed connection. */
    retainViewers(onlineViewerIds: ReadonlySet<string>): void {
        for (const viewerId of this.viewers.keys()) {
            if (!onlineViewerIds.has(viewerId)) this.viewers.delete(viewerId);
        }
    }

    /** Drops all renderer state after unload cleanup has been attempted. */
    clear(): void {
        this.viewers.clear();
    }

    private viewerState(viewer: WaypointHudViewer): ViewerState {
        let state = this.viewers.get(viewer.id);
        if (state === undefined) {
            state = {
                dimension: viewer.dimension,
                eyePosition: { ...viewer.eyePosition },
                nextEntityId: FIRST_CLIENT_ENTITY_ID,
                displays: new Map()
            };
            this.viewers.set(viewer.id, state);
        } else if (state.dimension !== viewer.dimension) {
            // The client discards the old world's entity table during dimension changes.
            state.displays.clear();
            state.dimension = viewer.dimension;
        }
        return state;
    }

    private removeUndesired(
        viewer: WaypointHudViewer,
        state: ViewerState,
        desired: ReadonlyMap<string, DesiredDisplay>
    ): void {
        const removals = [...state.displays.values()].filter(({ waypointId }) => !desired.has(waypointId));
        if (removals.length === 0) return;
        try {
            viewer.sendPacket(createEntityRemovePacket(removals.map(({ entityId }) => entityId)));
            for (const display of removals) state.displays.delete(display.waypointId);
        } catch (error) {
            // Keep entries until removal succeeds so a transient packet failure is retried next tick.
            this.report(viewer.id, error);
        }
    }

    private syncDisplay(
        viewer: WaypointHudViewer,
        state: ViewerState,
        waypointId: string,
        desired: DesiredDisplay
    ): void {
        let display = state.displays.get(waypointId);
        if (display === undefined) {
            display = {
                waypointId,
                entityId: this.allocateEntityId(state),
                entityUuid: viewer.createEntityUuid(),
                position: desired.position,
                elevation: desired.elevation,
                textJson: undefined,
                scale: undefined,
                opacity: undefined,
                presentation: desired.presentation,
                icon: undefined,
                spawned: false
            };
            state.displays.set(waypointId, display);
        }

        display.elevation = desired.elevation;
        display.presentation = desired.presentation;
        const position = desired.position;
        if (display.spawned && positionChanged(display.position, position)) {
            const movement = createTextDisplayMovement(display.entityId, display.position, position);
            if (movement === undefined) {
                // The supported relative packet carries signed 16-bit deltas; respawn on large same-world jumps.
                viewer.sendPacket(createEntityRemovePacket([display.entityId]));
                display.spawned = false;
                display.textJson = undefined;
            } else if (movement.packet !== undefined) {
                viewer.sendPacket(movement.packet);
            }
            display.position = movement?.position ?? position;
        }
        if (!display.spawned) display.position = position;

        if (!display.spawned) {
            viewer.sendPacket(createTextDisplaySpawnPacket(display.entityId, display.entityUuid, display.position));
            display.spawned = true;
        }
        if (display.textJson !== desired.textJson || display.icon !== desired.icon) {
            const componentNbt = appendWaypointIcon(viewer.encodeTextComponent(desired.textJson), desired.icon);
            viewer.sendPacket(
                createTextDisplayMetadataPacket(
                    display.entityId,
                    componentNbt,
                    desired.scale,
                    desired.presentation.opacity
                )
            );
            display.textJson = desired.textJson;
            display.scale = desired.scale;
            display.opacity = desired.presentation.opacity;
            display.icon = desired.icon;
        } else if (display.scale !== desired.scale || display.opacity !== desired.presentation.opacity) {
            viewer.sendPacket(
                createTextDisplayAppearancePacket(display.entityId, {
                    ...(display.scale === desired.scale ? {} : { scale: desired.scale }),
                    ...(display.opacity === desired.presentation.opacity
                        ? {}
                        : { opacity: desired.presentation.opacity })
                })
            );
            display.scale = desired.scale;
            display.opacity = desired.presentation.opacity;
        }
    }

    private allocateEntityId(state: ViewerState): number {
        const used = new Set([...state.displays.values()].map(({ entityId }) => entityId));
        while (used.has(state.nextEntityId) && state.nextEntityId >= LAST_CLIENT_ENTITY_ID) {
            state.nextEntityId -= 1;
        }
        if (state.nextEntityId < LAST_CLIENT_ENTITY_ID)
            throw new RangeError('Waypoint HUD entity ID range is exhausted.');
        return state.nextEntityId--;
    }

    private report(viewerId: string, error: unknown): void {
        try {
            this.onError(viewerId, error);
        } catch {
            // Error reporting must not stop other viewers from being reconciled.
        }
    }
}

interface DesiredDisplay {
    readonly icon: string | undefined;
    readonly position: WaypointPosition;
    readonly elevation: number;
    readonly scale: number;
    readonly presentation: WaypointHudPresentation;
    readonly textJson: string;
}

function distance(left: WaypointPosition, right: WaypointPosition): number {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function positionChanged(left: WaypointPosition, right: WaypointPosition): boolean {
    return left.x !== right.x || left.y !== right.y || left.z !== right.z;
}
