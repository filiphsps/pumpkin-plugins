import type { WaypointPosition } from '../waypoints/model.ts';

const MAX_HUD_DISTANCE = 24;
const TEXT_SCALE_PER_BLOCK = 0.18;
const STACK_ELEVATION_STEP = 0.1;
const WORLD_BLEND_START_DISTANCE = 16;
const WORLD_BLEND_END_DISTANCE = 3;
const ORDINARY_ELEVATION_FOLLOW_RATE = 0.08;
const STEEP_ELEVATION_FOLLOW_RATE = 0.4;
const STEEP_ELEVATION_START = Math.PI / 12;
const STEEP_ELEVATION_END = Math.PI / 4;
const ELEVATION_SNAP_DISTANCE = 0.00001;

/** One marker's world position and the elevation carried into its next render tick. */
export interface WaypointHudPlacement {
    readonly position: WaypointPosition;
    readonly elevation: number;
    readonly scale: number;
}

/**
 * Places a distant marker on a viewer-centered sphere along the waypoint's world bearing. Only
 * elevation is filtered; the eye origin and horizontal bearing follow the current position directly.
 * Nearby markers blend continuously into their real world anchor, independently of camera rotation.
 */
export function placeWaypointHud(
    eyePosition: WaypointPosition,
    worldAnchor: WaypointPosition,
    waypointDistance: number,
    previousElevation: number | undefined,
    stackIndex = 0
): WaypointHudPlacement {
    const x = worldAnchor.x - eyePosition.x;
    const y = worldAnchor.y - eyePosition.y;
    const z = worldAnchor.z - eyePosition.z;
    const horizontalDistance = Math.hypot(x, z);
    const worldBlend = smoothstep(
        (WORLD_BLEND_START_DISTANCE - waypointDistance) / (WORLD_BLEND_START_DISTANCE - WORLD_BLEND_END_DISTANCE)
    );
    const rawElevation = Math.min(
        Math.PI / 2,
        Math.atan2(y, horizontalDistance) + stackIndex * STACK_ELEVATION_STEP * (1 - worldBlend)
    );
    const steepness = smoothstep(
        (Math.abs(rawElevation) - STEEP_ELEVATION_START) / (STEEP_ELEVATION_END - STEEP_ELEVATION_START)
    );
    const hudFollowRate =
        ORDINARY_ELEVATION_FOLLOW_RATE + (STEEP_ELEVATION_FOLLOW_RATE - ORDINARY_ELEVATION_FOLLOW_RATE) * steepness;
    const followRate = hudFollowRate + (1 - hudFollowRate) * worldBlend;
    const elevation =
        previousElevation === undefined ||
        horizontalDistance === 0 ||
        worldBlend === 1 ||
        Math.abs(rawElevation - previousElevation) <= ELEVATION_SNAP_DISTANCE
            ? rawElevation
            : previousElevation + (rawElevation - previousElevation) * followRate;

    // World direction has no division by camera-forward depth, so side/behind markers cannot fly away.
    const targetDistance = Math.hypot(x, y, z);
    // A soft minimum avoids the velocity kink of a fixed-radius clamp. Farther proxies reduce
    // bearing error from delayed server samples; the radius always stays short of the destination.
    const hudRadius = targetDistance / (1 + targetDistance / MAX_HUD_DISTANCE);
    const horizontalRadius = Math.min(horizontalDistance, Math.cos(elevation) * hudRadius);
    const hudPosition = {
        x: eyePosition.x + (horizontalDistance === 0 ? 0 : (x / horizontalDistance) * horizontalRadius),
        y: eyePosition.y + Math.sin(elevation) * hudRadius,
        z: eyePosition.z + (horizontalDistance === 0 ? 0 : (z / horizontalDistance) * horizontalRadius)
    };
    const position =
        worldBlend === 1
            ? worldAnchor
            : {
                  x: hudPosition.x + (worldAnchor.x - hudPosition.x) * worldBlend,
                  y: hudPosition.y + (worldAnchor.y - hudPosition.y) * worldBlend,
                  z: hudPosition.z + (worldAnchor.z - hudPosition.z) * worldBlend
              };
    const renderedDistance = Math.hypot(
        position.x - eyePosition.x,
        position.y - eyePosition.y,
        position.z - eyePosition.z
    );
    return {
        position,
        elevation,
        // Quantize scale to avoid metadata churn from floating point noise at a fixed HUD distance.
        scale: Math.round(Math.max(0.25, renderedDistance) * TEXT_SCALE_PER_BLOCK * 4096) / 4096
    };
}

/** Blends smoothly between zero and one with zero slope at both endpoints. */
function smoothstep(value: number): number {
    const amount = Math.max(0, Math.min(1, value));
    return amount * amount * (3 - 2 * amount);
}
