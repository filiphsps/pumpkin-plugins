import { PLUGIN_NAME } from '../name.ts';
import type { AccessGrant, Waypoint } from './model.ts';

/** Player and operator facts used to evaluate one waypoint's persisted ACL. */
export interface WaypointAccessContext {
    readonly playerId: string;
    readonly isOperator: boolean;
    readonly hasPermission?: (node: string) => boolean;
}

/** Evaluates public/restricted access and additive player, permission, and group-marker grants. */
export function canAccessWaypoint(waypoint: Waypoint, context: WaypointAccessContext): boolean {
    if (context.isOperator || waypoint.access.mode === 'public') return true;
    return waypoint.access.grants.some((grant) => grantMatches(grant, context));
}

function grantMatches(grant: AccessGrant, context: WaypointAccessContext): boolean {
    if (grant.type === 'player') return grant.playerId.toLowerCase() === context.playerId.toLowerCase();
    if (context.hasPermission === undefined) return false;
    const node = grant.type === 'group' ? `${PLUGIN_NAME}:group.${grant.slug}` : grant.node;
    return context.hasPermission(node);
}
