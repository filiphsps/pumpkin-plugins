import { describe, expect, it } from 'vitest';
import { placeWaypointHud } from './layout.ts';

describe('directional HUD placement', () => {
    it('limits apparent bearing error when the camera has moved beyond the last server sample', () => {
        const marker = placeWaypointHud({ x: 0, y: 65.62, z: 0 }, { x: 0, y: 66, z: 100 }, 100, undefined);
        // A camera 0.6 blocks ahead of the server sample: about two sprinting ticks.
        const shownBearing = Math.atan2(marker.position.x - 0.6, marker.position.z);
        const destinationBearing = Math.atan2(-0.6, 100);
        expect(Math.abs(shownBearing - destinationBearing)).toBeLessThan((5 * Math.PI) / 180);
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
