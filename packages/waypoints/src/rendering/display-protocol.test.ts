import { describe, expect, it } from 'vitest';

async function loadProtocol(): Promise<typeof import('./display-protocol.ts')> {
    const protocol = await import('./display-protocol.ts').catch(() => undefined);
    if (protocol === undefined) throw new Error('Could not load Java display packet helpers.');
    expect(protocol.encodeTextDisplayMetadata).toBeTypeOf('function');
    expect(protocol.createTextDisplaySpawnPacket).toBeTypeOf('function');
    expect(protocol.createEntityRemovePacket).toBeTypeOf('function');
    expect(protocol.createTextDisplayMovement).toBeTypeOf('function');
    return protocol;
}

describe('Java 26.3 text display packets', () => {
    it('fades both text and backdrop without resending its component', async () => {
        const protocol = await loadProtocol();
        expect(protocol.createTextDisplayAppearancePacket(-1_500_000_000, { opacity: 0 })).toEqual({
            tag: 'c-set-entity-metadata',
            val: { entityId: -1_500_000_000, metadata: Uint8Array.from([8, 1, 0, 25, 1, 0, 26, 0, 0, 255]) }
        });
        expect(protocol.createTextDisplayAppearancePacket(-1_500_000_000, { opacity: 255 })).toEqual({
            tag: 'c-set-entity-metadata',
            val: {
                entityId: -1_500_000_000,
                metadata: Uint8Array.from([8, 1, 0, 25, 1, 128, 128, 128, 128, 4, 26, 0, 255, 255])
            }
        });
    });

    it('sets full brightness and a text shadow so labels and icons remain legible at night', async () => {
        const protocol = await loadProtocol();
        const bytes = [...protocol.encodeTextDisplayMetadata(Uint8Array.of(10, 0, 0))];
        expect(bytes).toContain(16);
        const brightness = bytes.indexOf(16);
        expect(bytes.slice(brightness, brightness + 6)).toEqual([16, 1, 240, 129, 192, 7]);
        expect(bytes.slice(-4)).toEqual([27, 0, 3, 255]);
    });

    it('encodes centered text metadata with the pinned 26.3 indices and raw NBT component bytes', async () => {
        const protocol = await loadProtocol();
        expect([...protocol.encodeTextDisplayMetadata(Uint8Array.of(10, 0, 0))]).toEqual([
            8, 1, 0, 9, 1, 1, 10, 1, 1, 12, 39, 63, 128, 0, 0, 63, 128, 0, 0, 63, 128, 0, 0, 15, 0, 3, 16, 1, 240, 129,
            192, 7, 17, 3, 65, 32, 0, 0, 23, 5, 10, 0, 0, 24, 1, 172, 2, 25, 1, 128, 128, 128, 128, 4, 26, 0, 255, 27,
            0, 3, 255
        ]);
    });

    it('renders HUD text through world geometry', async () => {
        const protocol = await loadProtocol();
        expect([...protocol.encodeTextDisplayMetadata(Uint8Array.of(10, 0, 0)).slice(-4)]).toEqual([27, 0, 3, 255]);
    });

    it('updates scale without resending text or creating another entity', async () => {
        const protocol = await loadProtocol();
        expect(protocol.createTextDisplayAppearancePacket(-1_500_000_000, { scale: 0.5 })).toEqual({
            tag: 'c-set-entity-metadata',
            val: {
                entityId: -1_500_000_000,
                metadata: Uint8Array.from([8, 1, 0, 12, 39, 63, 0, 0, 0, 63, 0, 0, 0, 63, 0, 0, 0, 255])
            }
        });
    });

    it('spawns the pinned text display entity with the supplied UUID and world position', async () => {
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
            protocol.createTextDisplayMovement(-1_000_000_000, { x: 1, y: 2, z: 3 }, { x: 2, y: 2.5, z: 4 })
        ).toEqual({
            packet: {
                tag: 'c-update-entity-pos',
                val: {
                    entityId: -1_000_000_000,
                    delta: [4096, 2048, 4096],
                    onGround: true
                }
            },
            position: { x: 2, y: 2.5, z: 4 }
        });
    });

    it('retains sub-resolution movement until it can be encoded without position drift', async () => {
        const protocol = await loadProtocol();
        const previous = { x: 1, y: 2, z: 3 };
        const first = protocol.createTextDisplayMovement(-1_000_000_000, previous, { x: 1.0001, y: 2, z: 3 });
        expect(first).toEqual({ position: previous });

        const second = protocol.createTextDisplayMovement(-1_000_000_000, first?.position ?? previous, {
            x: 1.0002,
            y: 2,
            z: 3
        });
        expect(second).toEqual({
            packet: {
                tag: 'c-update-entity-pos',
                val: {
                    entityId: -1_000_000_000,
                    delta: [1, 0, 0],
                    onGround: true
                }
            },
            position: { x: 1 + 1 / 4096, y: 2, z: 3 }
        });
    });

    it('sets NBT-encoded component bytes without a JSON string length prefix', async () => {
        const protocol = await loadProtocol();
        expect(protocol.createTextDisplayMetadataPacket(-1_500_000_000, Uint8Array.of(10, 0, 0))).toEqual({
            tag: 'c-set-entity-metadata',
            val: {
                entityId: -1_500_000_000,
                metadata: Uint8Array.from([
                    8, 1, 0, 9, 1, 1, 10, 1, 1, 12, 39, 63, 128, 0, 0, 63, 128, 0, 0, 63, 128, 0, 0, 15, 0, 3, 16, 1,
                    240, 129, 192, 7, 17, 3, 65, 32, 0, 0, 23, 5, 10, 0, 0, 24, 1, 172, 2, 25, 1, 128, 128, 128, 128, 4,
                    26, 0, 255, 27, 0, 3, 255
                ])
            }
        });
    });
});
