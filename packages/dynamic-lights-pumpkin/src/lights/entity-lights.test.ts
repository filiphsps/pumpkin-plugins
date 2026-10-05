import { describe, expect, it } from 'vitest';
import { ClientLightTracker } from './client-light.ts';
import { EntityLightTracker } from './entity-lights.ts';

describe(EntityLightTracker.name, () => {
    it('sends only changed lights and clears entity lights that leave range', () => {
        const sent: string[] = [];
        const reset: string[] = [];
        const tracker = new EntityLightTracker(new ClientLightTracker((level) => level + 100));
        const client = {
            sendBlockChange: ({ x, y, z }: { x: number; y: number; z: number }, state: number) =>
                sent.push(`${x},${y},${z}:${state}`),
            resetBlockChange: ({ x, y, z }: { x: number; y: number; z: number }) => reset.push(`${x},${y},${z}`)
        };

        tracker.sync('player', client, [{ entityId: 2, position: { x: 1, y: 2, z: 3 }, level: 8 }]);
        tracker.sync('player', client, [{ entityId: 2, position: { x: 1, y: 2, z: 3 }, level: 8 }]);
        tracker.sync('player', client, []);

        expect(sent).toEqual(['1,2,3:108']);
        expect(reset).toEqual(['1,2,3']);
    });
});
