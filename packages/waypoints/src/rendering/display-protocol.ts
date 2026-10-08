import type { ClientboundPacket } from 'pumpkin:plugin/java-packets@0.1.0';
import type { Uuid } from 'pumpkin:plugin/uuid@0.1.0';

/** Protocol entity type IDs from Pumpkin's pinned Minecraft 26.3 registry. */
export const TEXT_DISPLAY_ENTITY_TYPE_ID = 135;

const BILLBOARD_CENTER = 3;
const POSITION_INTERPOLATION_TICKS = 1;
const TEXT_COMPONENT_META_TYPE = 5;
const VAR_INT_META_TYPE = 1;
const BYTE_META_TYPE = 0;
// Minecraft 26.3 registers Long at serializer 2, so Float uses serializer 3.
const FLOAT_META_TYPE = 3;
const VECTOR3_META_TYPE = 39;
const TEXT_LINE_WIDTH = 300;
const TEXT_BACKGROUND = 0x40000000;
const TEXT_DISPLAY_SEE_THROUGH = 0x02;
const TEXT_DISPLAY_SHADOW = 0x01;
const FULL_BRIGHTNESS = (15 << 4) | (15 << 20);
const TEXT_DISPLAY_VIEW_RANGE = 10;
const ENTITY_DELTA_SCALE = 4096;
const MIN_ENTITY_DELTA = -32_768;
const MAX_ENTITY_DELTA = 32_767;

/** Encodes TextDisplay metadata; 26.3 components are already network-NBT encoded by Pumpkin. */
export function encodeTextDisplayMetadata(componentNbt: Uint8Array, scale = 1, opacity = 255): Uint8Array {
    return Uint8Array.from([
        8,
        VAR_INT_META_TYPE,
        0,
        9,
        VAR_INT_META_TYPE,
        POSITION_INTERPOLATION_TICKS,
        10,
        VAR_INT_META_TYPE,
        POSITION_INTERPOLATION_TICKS,
        12,
        VECTOR3_META_TYPE,
        ...encodeScale(scale),
        15,
        BYTE_META_TYPE,
        BILLBOARD_CENTER,
        16,
        VAR_INT_META_TYPE,
        ...encodeVarInt(FULL_BRIGHTNESS),
        17,
        FLOAT_META_TYPE,
        ...encodeFloat(TEXT_DISPLAY_VIEW_RANGE),
        23,
        TEXT_COMPONENT_META_TYPE,
        ...componentNbt,
        24,
        VAR_INT_META_TYPE,
        ...encodeVarInt(TEXT_LINE_WIDTH),
        ...encodeOpacity(opacity),
        27,
        BYTE_META_TYPE,
        TEXT_DISPLAY_SEE_THROUGH | TEXT_DISPLAY_SHADOW,
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
export function createTextDisplayMetadataPacket(
    entityId: number,
    componentNbt: Uint8Array,
    scale = 1,
    opacity = 255
): ClientboundPacket {
    return {
        tag: 'c-set-entity-metadata',
        val: { entityId, metadata: encodeTextDisplayMetadata(componentNbt, scale, opacity) }
    };
}

/** Updates changed scale or opacity fields without resending text, using one-tick interpolation. */
export function createTextDisplayAppearancePacket(
    entityId: number,
    appearance: { readonly scale?: number; readonly opacity?: number }
): ClientboundPacket {
    return {
        tag: 'c-set-entity-metadata',
        val: {
            entityId,
            metadata: Uint8Array.from([
                8,
                VAR_INT_META_TYPE,
                0,
                ...(appearance.scale === undefined ? [] : [12, VECTOR3_META_TYPE, ...encodeScale(appearance.scale)]),
                ...(appearance.opacity === undefined ? [] : encodeOpacity(appearance.opacity)),
                255
            ])
        }
    };
}

/** Updates only a display's scale and restarts its one-tick transformation interpolation. */
export function createTextDisplayScalePacket(entityId: number, scale: number): ClientboundPacket {
    return {
        tag: 'c-set-entity-metadata',
        val: {
            entityId,
            metadata: Uint8Array.from([8, VAR_INT_META_TYPE, 0, 12, VECTOR3_META_TYPE, ...encodeScale(scale), 255])
        }
    };
}

/** One encoded movement and the position the client reaches after applying it. */
export interface TextDisplayMovement {
    readonly packet?: ClientboundPacket;
    readonly position: Vec3;
}

/** Encodes a display movement at Minecraft's 1/4096-block precision. */
export function createTextDisplayMovement(
    entityId: number,
    previous: Vec3,
    position: Vec3
): TextDisplayMovement | undefined {
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
    const nextPosition = {
        x: previous.x + delta[0] / ENTITY_DELTA_SCALE,
        y: previous.y + delta[1] / ENTITY_DELTA_SCALE,
        z: previous.z + delta[2] / ENTITY_DELTA_SCALE
    };
    if (delta.every((component) => component === 0)) return { position: nextPosition };
    return {
        packet: {
            tag: 'c-update-entity-pos',
            val: {
                entityId,
                // The pinned host casts these f64 fields directly to the protocol's i16 delta units.
                delta,
                onGround: true
            }
        },
        position: nextPosition
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

/** Encodes the view range as an IEEE-754 float in network byte order. */
function encodeFloat(value: number): number[] {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, false);
    return [...bytes];
}

/** Encodes a uniform display scale as three big-endian floats. */
function encodeScale(scale: number): number[] {
    const component = encodeFloat(scale);
    return [...component, ...component, ...component];
}

/** Fades the backdrop with the text so arriving never leaves an empty black rectangle. */
function encodeOpacity(opacity: number): number[] {
    const background = Math.round((opacity / 255) * (TEXT_BACKGROUND >>> 24)) << 24;
    return [25, VAR_INT_META_TYPE, ...encodeVarInt(background), 26, BYTE_META_TYPE, opacity];
}
