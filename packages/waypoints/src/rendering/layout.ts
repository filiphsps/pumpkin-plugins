import type { WaypointPosition } from '../waypoints/model.ts';

/** Camera pose sampled from one Java viewer. Angles use Minecraft degrees. */
export interface HudCamera {
    readonly position: WaypointPosition;
    readonly yaw: number;
    readonly pitch: number;
}

/** Projects a target onto a fixed-depth plane in front of the viewer, preserving its screen direction. */
export function projectWaypointOnCameraPlane(
    camera: HudCamera,
    target: WaypointPosition,
    depth: number
): WaypointPosition | undefined {
    if (
        !Number.isFinite(depth) ||
        depth <= 0 ||
        ![
            camera.position.x,
            camera.position.y,
            camera.position.z,
            camera.yaw,
            camera.pitch,
            target.x,
            target.y,
            target.z
        ].every(Number.isFinite)
    ) {
        return undefined;
    }

    const yaw = (camera.yaw * Math.PI) / 180;
    const pitch = (camera.pitch * Math.PI) / 180;
    const forward = {
        x: -Math.sin(yaw) * Math.cos(pitch),
        y: -Math.sin(pitch),
        z: Math.cos(yaw) * Math.cos(pitch)
    };
    const right = { x: Math.cos(yaw), y: 0, z: Math.sin(yaw) };
    const up = {
        x: -Math.sin(pitch) * Math.sin(yaw),
        y: Math.cos(pitch),
        z: Math.sin(pitch) * Math.cos(yaw)
    };
    const direction = {
        x: target.x - camera.position.x,
        y: target.y - camera.position.y,
        z: target.z - camera.position.z
    };
    const forwardDepth = dot(direction, forward);
    if (forwardDepth <= 0) return undefined;

    const horizontal = (dot(direction, right) / forwardDepth) * depth;
    const vertical = (dot(direction, up) / forwardDepth) * depth;
    return {
        x: camera.position.x + forward.x * depth + right.x * horizontal + up.x * vertical,
        y: camera.position.y + forward.y * depth + right.y * horizontal + up.y * vertical,
        z: camera.position.z + forward.z * depth + right.z * horizontal + up.z * vertical
    };
}

function dot(left: WaypointPosition, right: WaypointPosition): number {
    return left.x * right.x + left.y * right.y + left.z * right.z;
}
