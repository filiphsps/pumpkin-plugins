import { describe, expect, it } from 'vitest';

async function loadProtocol(): Promise<typeof import('./display-protocol.ts')> {
    const protocol = await import('./display-protocol.ts').catch(() => undefined);
    if (protocol === undefined) throw new Error('Could not load Java display packet helpers.');
    expect(protocol.encodeTextDisplayMetadata).toBeTypeOf('function');
    expect(protocol.createTextDisplaySpawnPacket).toBeTypeOf('function');
    expect(protocol.createEntityRemovePacket).toBeTypeOf('function');
    expect(protocol.createTextDisplayMovePacket).toBeTypeOf('function');
    return protocol;
}

describe('Java 26.3 text display packets', () => {
    it('encodes centered text metadata with the pinned 26.3 indices and raw NBT component bytes', async () => {
        const protocol = await loadProtocol();
        expect([...protocol.encodeTextDisplayMetadata(Uint8Array.of(10, 0, 0))]).toEqual([
            15, 0, 3, 23, 5, 10, 0, 0, 24, 1, 172, 2, 25, 1, 128, 128, 128, 128, 4, 26, 0, 255, 27, 0, 0, 255
        ]);
    });

    it('spawns the pinned text display entity with the supplied UUID and camera-plane position', async () => {
        const protocol = await loadProtocol();
        expect(
            protocol.createTextDisplaySpawnPacket(-1_000_000_000, { high: 1n, low: 2n }, { x: 1, y: 2, z: 3 })
        ).toEqual({
            tag: 'c-spawn-entity',
            val: {
                entityId: -1_000_000_000,
                entityUuid: { high: 1n, low: 2n },
                rType: 135,
                position: [1, 2, 3],
                velocity: '[0,0,0]',
                pitch: 0,
                yaw: 0,
                headYaw: 0,
                data: 0
            }
        });
    });

    it('removes only the supplied fake entity IDs', async () => {
        const protocol = await loadProtocol();
        expect(protocol.createEntityRemovePacket([-1_000_000_000, -999_999_999])).toEqual({
            tag: 'c-remove-entities',
            val: { entityIds: new Int32Array([-1_000_000_000, -999_999_999]) }
        });
    });

    it('encodes supported relative movement in Minecraft fixed-point units', async () => {
        const protocol = await loadProtocol();
        expect(
            protocol.createTextDisplayMovePacket(-1_000_000_000, { x: 1, y: 2, z: 3 }, { x: 2, y: 2.5, z: 4 })
        ).toEqual({
            tag: 'c-update-entity-pos',
            val: {
                entityId: -1_000_000_000,
                delta: [4096, 2048, 4096],
                onGround: true
            }
        });
    });

    it('sets NBT-encoded component bytes without a JSON string length prefix', async () => {
        const protocol = await loadProtocol();
        expect(protocol.createTextDisplayMetadataPacket(-1_500_000_000, Uint8Array.of(10, 0, 0))).toEqual({
            tag: 'c-set-entity-metadata',
            val: {
                entityId: -1_500_000_000,
                metadata: Uint8Array.from([
                    15, 0, 3, 23, 5, 10, 0, 0, 24, 1, 172, 2, 25, 1, 128, 128, 128, 128, 4, 26, 0, 255, 27, 0, 0, 255
                ])
            }
        });
    });
});
