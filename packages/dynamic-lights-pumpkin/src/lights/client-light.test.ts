import { describe, expect, it } from 'vitest';
import {
    type BlockPosition,
    ClientLightTracker,
    clientLightStates,
    findLightPosition,
    type LightClient
} from './client-light.ts';

describe(ClientLightTracker.name, () => {
    it('sends a fake block and resets it after the player moves', () => {
        const client = new FakeClient();
        const tracker = new ClientLightTracker((level) => level);

        tracker.sync('Alex', client, block(1, 64, 1), 14);
        tracker.sync('Alex', client, block(2, 64, 1), 14);

        expect(client.changes).toEqual([
            ['fake', block(1, 64, 1), 14],
            ['reset', block(1, 64, 1)],
            ['fake', block(2, 64, 1), 14]
        ]);
    });

    it('resets the actual block after the held source is removed', () => {
        const client = new FakeClient();
        const tracker = new ClientLightTracker((level) => level);

        tracker.sync('Alex', client, block(1, 64, 1), 14);
        tracker.sync('Alex', client, block(1, 64, 1), 0);

        expect(client.changes).toEqual([
            ['fake', block(1, 64, 1), 14],
            ['reset', block(1, 64, 1)]
        ]);
    });
});

describe(clientLightStates.name, () => {
    it('resolves every light level from the injected block registry', () => {
        const states = clientLightStates((_blockName, properties) => Number(properties[0][1]));

        expect(states?.(14)).toBe(14);
    });
});

describe(findLightPosition.name, () => {
    it('skips a real block at the player position for air above it', () => {
        expect(findLightPosition(block(1, 64, 1), (position) => position.y === 65)).toEqual(block(1, 65, 1));
    });
});

class FakeClient implements LightClient {
    readonly changes: (['fake', BlockPosition, number] | ['reset', BlockPosition])[] = [];

    sendBlockChange(position: BlockPosition, stateId: number): void {
        this.changes.push(['fake', position, stateId]);
    }

    resetBlockChange(position: BlockPosition): void {
        this.changes.push(['reset', position]);
    }
}

function block(x: number, y: number, z: number): BlockPosition {
    return { x, y, z };
}
