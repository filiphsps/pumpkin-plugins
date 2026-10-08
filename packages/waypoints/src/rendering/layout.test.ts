import { describe, expect, it } from 'vitest';

async function loadProjection(): Promise<
    (
        camera: { position: { x: number; y: number; z: number }; yaw: number; pitch: number },
        target: { x: number; y: number; z: number },
        depth: number
    ) => { x: number; y: number; z: number } | undefined
> {
    const layout = await import('./layout.ts').catch(() => undefined);
    if (layout === undefined) throw new Error('Could not load waypoint HUD layout.');
    expect(layout.projectWaypointOnCameraPlane).toBeTypeOf('function');
    return layout.projectWaypointOnCameraPlane;
}

describe('waypoint HUD layout', () => {
    it('places a camera-facing marker on a fixed-depth plane along the waypoint direction', async () => {
        const project = await loadProjection();
        expect(project({ position: { x: 0, y: 2, z: 0 }, yaw: 0, pitch: 0 }, { x: 10, y: 2, z: 10 }, 6)).toEqual({
            x: 6,
            y: 2,
            z: 6
        });
    });

    it('uses sampled yaw and pitch to keep the marker in front of the player', async () => {
        const project = await loadProjection();
        expect(project({ position: { x: 0, y: 2, z: 0 }, yaw: 90, pitch: 0 }, { x: -10, y: 2, z: 10 }, 6)).toEqual({
            x: -6,
            y: 2,
            z: 6
        });
    });

    it('omits a waypoint that is behind the viewer', async () => {
        const project = await loadProjection();
        expect(
            project({ position: { x: 0, y: 2, z: 0 }, yaw: 0, pitch: 0 }, { x: 0, y: 2, z: -10 }, 6)
        ).toBeUndefined();
    });

    it('keeps a nearby waypoint at eye height while looking down', async () => {
        const project = await loadProjection();
        const camera = { position: { x: 0, y: 65.62, z: 0 }, yaw: 40, pitch: 70 };

        expect(project(camera, { x: 0, y: 64, z: 0 }, 3)).toEqual({
            x: -Math.sin((40 * Math.PI) / 180) * 3,
            y: 65.62,
            z: Math.cos((40 * Math.PI) / 180) * 3
        });
    });
});
