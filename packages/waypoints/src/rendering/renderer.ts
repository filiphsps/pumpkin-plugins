import type { ClientboundPacket } from 'pumpkin:plugin/java-packets@0.1.0';
import type { Uuid } from 'pumpkin:plugin/uuid@0.1.0';
import type { Waypoint, WaypointPosition } from '../waypoints/model.ts';
import { projectWaypointsForViewer } from '../waypoints/visibility.ts';
import {
    createEntityRemovePacket,
    createTextDisplayMetadataPacket,
    createTextDisplayMovement,
    createTextDisplaySpawnPacket
} from './display-protocol.ts';
import {
    cameraPlaneCoordinates,
    offsetOnCameraPlane,
    type HudCamera,
    projectWaypointOnCameraPlane
} from './layout.ts';

const DEFAULT_DISPLAY_DEPTH = 3;
const FIRST_CLIENT_ENTITY_ID = -1_500_000_000;
const LAST_CLIENT_ENTITY_ID = -2_000_000_000;
const PLAYER_MOVEMENT_THRESHOLD = 0.01;
const STATIONARY_YAW_FOLLOW_RATE = 0.05;
const LABEL_CHARACTER_WIDTH = 0.075;
const DISTANCE_TEXT_WIDTH_CHARS = 10;
const LABEL_COLLISION_HEIGHT = 0.24;
const LABEL_VERTICAL_STEP = 0.32;

/** Per-viewer inputs required to render one private waypoint HUD. */
export interface WaypointHudViewer {
    readonly id: string;
    dimension: string;
    position: WaypointPosition;
    camera: HudCamera;
    readonly isOperator: boolean;
    readonly hasPermission: (node: string) => boolean;
    readonly createEntityUuid: () => Uuid;
    readonly encodeTextComponent: (textJson: string) => Uint8Array;
    readonly sendPacket: (packet: ClientboundPacket) => void;
}

/** Options for the client-only Java waypoint renderer. */
export interface WaypointHudRendererOptions {
    readonly depth?: number;
    readonly onError?: (viewerId: string, error: unknown) => void;
}

interface DisplayState {
    readonly waypointId: string;
    readonly entityId: number;
    readonly entityUuid: Uuid;
    position: WaypointPosition;
    textJson: string | undefined;
    spawned: boolean;
}

interface ViewerState {
    dimension: string;
    nextEntityId: number;
    lastPlayerPosition: WaypointPosition;
    projectionYaw: number;
    projectionPitch: number;
    readonly displays: Map<string, DisplayState>;
}

/**
 * Renders access-filtered waypoints as client-only Java TextDisplays. Each viewer gets an
 * independent entity ledger, so restricted waypoint labels and personalized distances never
 * enter another player's packet stream.
 */
export class WaypointHudRenderer {
    private readonly viewers = new Map<string, ViewerState>();
    private readonly depth: number;
    private readonly onError: (viewerId: string, error: unknown) => void;

    constructor(options: WaypointHudRendererOptions = {}) {
        this.depth = options.depth ?? DEFAULT_DISPLAY_DEPTH;
        this.onError = options.onError ?? (() => undefined);
    }

    /** Renders one viewer's current authorized projection and diffs its display packets. */
    renderViewer(viewer: WaypointHudViewer, waypoints: readonly Waypoint[]): void {
        const state = this.viewerState(viewer);
        const camera = this.projectionCamera(viewer, state);
        const visible = projectWaypointsForViewer(waypoints, {
            playerId: viewer.id,
            isOperator: viewer.isOperator,
            hasPermission: viewer.hasPermission,
            dimension: viewer.dimension,
            position: viewer.position
        });
        const candidates: DisplayCandidate[] = [];
        for (const waypoint of visible) {
            const projected = projectWaypointOnCameraPlane(camera, waypoint.position, this.depth);
            if (projected === undefined) continue;
            const label = waypoint.label ?? waypoint.name;
            const distanceBlocks = distance(viewer.position, waypoint.position);
            candidates.push({
                waypointId: waypoint.id,
                position: projected,
                textJson: createWaypointHudTextJson(waypoint, distanceBlocks),
                width: Math.max(0.7, (Array.from(label).length + DISTANCE_TEXT_WIDTH_CHARS) * LABEL_CHARACTER_WIDTH)
            });
        }
        candidates.sort((left, right) => left.waypointId.localeCompare(right.waypointId));

        const desired = new Map<string, DesiredDisplay>();
        const placed: PlacedLabel[] = [];
        for (const candidate of candidates) {
            let position = candidate.position;
            let verticalOffset = 0;
            while (overlaps(camera, position, candidate.width, placed)) {
                verticalOffset += LABEL_VERTICAL_STEP;
                position = offsetOnCameraPlane(camera, candidate.position, verticalOffset);
            }
            placed.push({ position, width: candidate.width });
            desired.set(candidate.waypointId, { position, textJson: candidate.textJson });
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
                nextEntityId: FIRST_CLIENT_ENTITY_ID,
                lastPlayerPosition: { ...viewer.position },
                projectionYaw: viewer.camera.yaw,
                projectionPitch: viewer.camera.pitch,
                displays: new Map()
            };
            this.viewers.set(viewer.id, state);
        } else if (state.dimension !== viewer.dimension) {
            // The client discards the old world's entity table during dimension changes.
            state.displays.clear();
            state.dimension = viewer.dimension;
            state.lastPlayerPosition = { ...viewer.position };
            state.projectionYaw = viewer.camera.yaw;
            state.projectionPitch = viewer.camera.pitch;
        }
        return state;
    }

    private projectionCamera(viewer: WaypointHudViewer, state: ViewerState): HudCamera {
        const moved = distance(viewer.position, state.lastPlayerPosition) > PLAYER_MOVEMENT_THRESHOLD;
        if (moved || !Number.isFinite(state.projectionYaw) || !Number.isFinite(viewer.camera.yaw)) {
            state.projectionYaw = viewer.camera.yaw;
        } else {
            state.projectionYaw = smoothYaw(state.projectionYaw, viewer.camera.yaw, STATIONARY_YAW_FOLLOW_RATE);
        }
        if (moved || !Number.isFinite(state.projectionPitch) || !Number.isFinite(viewer.camera.pitch)) {
            state.projectionPitch = viewer.camera.pitch;
        }
        state.lastPlayerPosition = { ...viewer.position };
        return { ...viewer.camera, yaw: state.projectionYaw, pitch: state.projectionPitch };
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
                textJson: undefined,
                spawned: false
            };
            state.displays.set(waypointId, display);
        }

        if (display.spawned && positionChanged(display.position, desired.position)) {
            const movement = createTextDisplayMovement(display.entityId, display.position, desired.position);
            if (movement === undefined) {
                // The supported relative packet carries signed 16-bit deltas; respawn on large same-world jumps.
                viewer.sendPacket(createEntityRemovePacket([display.entityId]));
                display.spawned = false;
                display.textJson = undefined;
            } else {
                if (movement.packet !== undefined) viewer.sendPacket(movement.packet);
            }
            display.position = movement?.position ?? desired.position;
        }

        if (!display.spawned) {
            viewer.sendPacket(createTextDisplaySpawnPacket(display.entityId, display.entityUuid, display.position));
            display.spawned = true;
        }
        if (display.textJson !== desired.textJson) {
            const componentNbt = viewer.encodeTextComponent(desired.textJson);
            viewer.sendPacket(createTextDisplayMetadataPacket(display.entityId, componentNbt));
            display.textJson = desired.textJson;
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

/** Creates a literal name and rounded-distance component using the waypoint color. */
export function createWaypointHudTextJson(waypoint: Waypoint, distanceBlocks: number): string {
    const label = waypoint.label ?? waypoint.name;
    const distanceText = `${Math.round(distanceBlocks)}m`;
    return JSON.stringify({
        text: '',
        extra: [
            { text: label, color: waypoint.color, bold: true },
            { text: ` (${distanceText})`, color: '#FFFFFF' }
        ]
    });
}

interface DesiredDisplay {
    readonly position: WaypointPosition;
    readonly textJson: string;
}

interface DisplayCandidate extends DesiredDisplay {
    readonly waypointId: string;
    readonly width: number;
}

interface PlacedLabel {
    readonly position: WaypointPosition;
    readonly width: number;
}

function distance(left: WaypointPosition, right: WaypointPosition): number {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function positionChanged(left: WaypointPosition, right: WaypointPosition): boolean {
    return left.x !== right.x || left.y !== right.y || left.z !== right.z;
}

function smoothYaw(current: number, target: number, followRate: number): number {
    const difference = (((target - current + 180) % 360) + 360) % 360 - 180;
    return current + difference * followRate;
}

function overlaps(
    camera: HudCamera,
    position: WaypointPosition,
    width: number,
    placed: readonly PlacedLabel[]
): boolean {
    const candidate = cameraPlaneCoordinates(camera, position);
    return placed.some(({ position: otherPosition, width: otherWidth }) => {
        const other = cameraPlaneCoordinates(camera, otherPosition);
        return (
            Math.abs(candidate.horizontal - other.horizontal) < (width + otherWidth) / 2 &&
            Math.abs(candidate.vertical - other.vertical) < LABEL_COLLISION_HEIGHT
        );
    });
}
