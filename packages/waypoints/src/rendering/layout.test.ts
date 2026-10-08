import { describe, expect, it } from 'vitest';
import { placeWaypointHud } from './layout.ts';

describe('directional HUD placement', () => {
    it('limits apparent bearing error when the camera has moved beyond the last server sample', () => {
        const marker = placeWaypointHud({ x: 0, y: 65.62, z: 0 }, { x: 0, y: 66, z: 100 }, 100, undefined);
        // A camera 0.6 blocks ahead of the server sample: about two sprinting ticks.
        const shownBearing = Math.atan2(marker.position.x - 0.6, marker.position.z);
        const destinationBearing = Math.atan2(-0.6, 100);
        expect(Math.abs(shownBearing - destinationBearing)).toBeLessThan((2 * Math.PI) / 180);
    });

    it('keeps a partial projection until the final approach and anchors exactly inside three blocks', () => {
        const anchor = { x: 0, y: 0, z: 6 };
        const projected = placeWaypointHud({ x: 0, y: 0, z: 0 }, anchor, 6, undefined);
        expect(anchor.z - projected.position.z).toBeGreaterThan(0.1);
        expect(projected.position.z).toBeGreaterThan(0);
        expect(placeWaypointHud({ x: 0, y: 0, z: 3 }, anchor, 3, projected.elevation).position).toEqual(anchor);
    });

    it('eases depth without a velocity kink at the old radius or either blend boundary', () => {
        const depth = (distance: number) =>
            placeWaypointHud({ x: 0, y: 0, z: 100 - distance }, { x: 0, y: 0, z: 100 }, distance, 0).position.z;
        for (const distance of [3, 8, 10, 16]) {
            const before = (depth(distance) - depth(distance + 0.01)) / 0.01;
            const after = (depth(distance - 0.01) - depth(distance)) / 0.01;
            expect(Math.abs(after - before)).toBeLessThan(0.01);
        }
        let previous = depth(30);
        for (let distance = 29.9; distance >= 0; distance -= 0.1) {
            const current = depth(distance);
            expect(current).toBeGreaterThanOrEqual(previous - 1e-9);
            expect(current).toBeLessThanOrEqual(100);
            previous = current;
        }
    });

    it('keeps text angular size consistent through the HUD and world-anchor transition', () => {
        let previousElevation: number | undefined;
        for (let z = 0; z <= 20; z += 0.25) {
            const eye = { x: 0, y: 65.62, z };
            const marker = placeWaypointHud(eye, { x: 0, y: 66, z: 20 }, 20 - z, previousElevation);
            previousElevation = marker.elevation;
            const renderedDistance = Math.hypot(marker.position.x, marker.position.y - eye.y, marker.position.z - z);
            expect(marker.scale / renderedDistance).toBeCloseTo(0.18, 2);
        }
    });
});
