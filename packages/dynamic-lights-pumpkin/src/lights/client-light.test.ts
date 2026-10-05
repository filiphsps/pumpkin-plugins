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

    it('keeps overlapping held and entity lights at the brightest level', () => {
        const client = new FakeClient();
        const tracker = new ClientLightTracker((level) => level);
        const position = block(1, 64, 1);
        tracker.sync('Alex', client, position, 14);
        tracker.replaceSources('Alex', client, 'entities', [
            { position, level: 8 },
            { position, level: 15 }
        ]);
        tracker.replaceSources('Alex', client, 'entities', [{ position, level: 8 }]);
        tracker.remove('Alex', client);
        tracker.replaceSources('Alex', client, 'entities', []);

        expect(client.changes).toEqual([
            ['fake', position, 14],
            ['fake', position, 15],
            ['fake', position, 14],
            ['fake', position, 8],
            ['reset', position]
        ]);
    });

    it('reconciles an entity snapshot without resetting cells retained by another entity', () => {
        const client = new FakeClient();
        const tracker = new ClientLightTracker((level) => level);
        const first = block(1, 64, 1);
        const second = block(2, 64, 1);
        tracker.replaceSources('Alex', client, 'entities', [
            { position: first, level: 8 },
            { position: second, level: 14 }
        ]);
        tracker.replaceSources('Alex', client, 'entities', [{ position: first, level: 14 }]);

        expect(client.changes).toEqual([
            ['fake', first, 8],
            ['fake', second, 14],
            ['reset', second],
            ['fake', first, 14]
        ]);
    });

    it('forgets world changes without sending resets into the new world', () => {
        const client = new FakeClient();
        const tracker = new ClientLightTracker((level) => level);
        const position = block(1, 64, 1);
        tracker.sync('Alex', client, position, 14);
        tracker.forget('Alex');
        tracker.sync('Alex', client, position, 14);
        tracker.reset('Alex', client);

        expect(client.changes).toEqual([
            ['fake', position, 14],
            ['fake', position, 14],
            ['reset', position]
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
