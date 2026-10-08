import type { ClientboundPacket } from 'pumpkin:plugin/java-packets@0.1.0';
import type { Uuid } from 'pumpkin:plugin/uuid@0.1.0';

/** Protocol entity type IDs from Pumpkin's pinned Minecraft 26.3 registry. */
export const TEXT_DISPLAY_ENTITY_TYPE_ID = 135;

const BILLBOARD_CENTER = 3;
const TEXT_COMPONENT_META_TYPE = 5;
const VAR_INT_META_TYPE = 1;
const BYTE_META_TYPE = 0;
const TEXT_LINE_WIDTH = 300;
const TEXT_BACKGROUND = 0x40000000;
const ENTITY_DELTA_SCALE = 4096;
const MIN_ENTITY_DELTA = -32_768;
const MAX_ENTITY_DELTA = 32_767;

/** Encodes TextDisplay metadata; 26.3 components are already network-NBT encoded by Pumpkin. */
export function encodeTextDisplayMetadata(componentNbt: Uint8Array): Uint8Array {
    return Uint8Array.from([
        15,
        BYTE_META_TYPE,
        BILLBOARD_CENTER,
        23,
        TEXT_COMPONENT_META_TYPE,
        ...componentNbt,
        24,
        VAR_INT_META_TYPE,
        ...encodeVarInt(TEXT_LINE_WIDTH),
        25,
        VAR_INT_META_TYPE,
        ...encodeVarInt(TEXT_BACKGROUND),
        26,
        BYTE_META_TYPE,
        255,
        27,
        BYTE_META_TYPE,
        0,
        255
    ]);
}

/** Builds the pinned 26.3 Java packet that creates a client-only TextDisplay entity. */
export function createTextDisplaySpawnPacket(entityId: number, entityUuid: Uuid, position: Vec3): ClientboundPacket {
    return {
        tag: 'c-spawn-entity',
        val: {
            entityId,
            entityUuid,
            rType: TEXT_DISPLAY_ENTITY_TYPE_ID,
            position: [position.x, position.y, position.z],
            velocity: JSON.stringify([0, 0, 0]),
            pitch: 0,
            yaw: 0,
            headYaw: 0,
            data: 0
        }
    };
}

/** Builds the Java packet that removes fake entities from one client's entity table. */
export function createEntityRemovePacket(entityIds: readonly number[]): ClientboundPacket {
    return {
        tag: 'c-remove-entities',
        val: { entityIds: Int32Array.from(entityIds) }
    };
}

/** Builds the Java packet that applies metadata to one fake entity. */
export function createTextDisplayMetadataPacket(entityId: number, componentNbt: Uint8Array): ClientboundPacket {
    return {
        tag: 'c-set-entity-metadata',
        val: { entityId, metadata: encodeTextDisplayMetadata(componentNbt) }
    };
}

/** Moves a client-only display with the relative packet supported by Pumpkin's pinned serializer. */
export function createTextDisplayMovePacket(
    entityId: number,
    previous: Vec3,
    position: Vec3
): ClientboundPacket | undefined {
    const delta: [number, number, number] = [
        Math.round((position.x - previous.x) * ENTITY_DELTA_SCALE),
        Math.round((position.y - previous.y) * ENTITY_DELTA_SCALE),
        Math.round((position.z - previous.z) * ENTITY_DELTA_SCALE)
    ];
    if (
        delta.some(
            (component) => !Number.isFinite(component) || component < MIN_ENTITY_DELTA || component > MAX_ENTITY_DELTA
        )
    ) {
        return undefined;
    }
    return {
        tag: 'c-update-entity-pos',
        val: {
            entityId,
            // The pinned host casts these f64 fields directly to the protocol's i16 delta units.
            delta,
            onGround: true
        }
    };
}

/** A three-dimensional coordinate serialized in a Java entity packet. */
export interface Vec3 {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/** Encodes a non-negative Java protocol VarInt used by the display metadata fields. */
function encodeVarInt(value: number): number[] {
    const bytes: number[] = [];
    let remaining = value >>> 0;
    do {
        let byte = remaining & 0x7f;
        remaining >>>= 7;
        if (remaining !== 0) byte |= 0x80;
        bytes.push(byte);
    } while (remaining !== 0);
    return bytes;
}
