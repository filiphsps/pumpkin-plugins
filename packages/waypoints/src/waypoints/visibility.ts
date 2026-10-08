import { canAccessWaypoint, type WaypointAccessContext } from './access.ts';
import type { Waypoint, WaypointPosition } from './model.ts';

/** The current player state needed to derive renderer-visible waypoint records. */
export interface WaypointViewer extends WaypointAccessContext {
    readonly dimension: string;
    readonly position: WaypointPosition;
}

/** Returns enabled, authorized, same-dimension waypoints within their optional 3D range. */
export function projectWaypointsForViewer(waypoints: readonly Waypoint[], viewer: WaypointViewer): Waypoint[] {
    return waypoints.filter((waypoint) => {
        if (!waypoint.enabled || waypoint.dimension !== viewer.dimension || !canAccessWaypoint(waypoint, viewer)) {
            return false;
        }
        return (
            waypoint.visibilityRange === undefined ||
            distance(viewer.position, waypoint.position) <= waypoint.visibilityRange
        );
    });
}

function distance(left: WaypointPosition, right: WaypointPosition): number {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
