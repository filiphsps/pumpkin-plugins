// The wire format AppleSkin's client expects, taken from the mod's own payload records. Every one
// of them is server to client and carries a bare value with no header, because the channel name in
// the packet already says what the bytes are.

/** The player's saturation level, which vanilla only sends when it reaches zero. */
export const SATURATION_CHANNEL = 'appleskin:saturation';

/** The player's exhaustion level, which vanilla never sends at all. */
export const EXHAUSTION_CHANNEL = 'appleskin:exhaustion';

/** Whether the player's world heals them by food, which the client assumes is on. */
export const NATURAL_REGENERATION_CHANNEL = 'appleskin:natural_regeneration';

/**
 * Encodes a number the way the client reads it.
 * @param value - The number to send.
 * @returns A big-endian 32-bit float, which is what the mod's payload reader expects.
 */
export function floatPayload(value: number): Uint8Array {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value);
    return bytes;
}

/**
 * Encodes a flag the way the client reads it.
 * @param value - The flag to send.
 * @returns One byte, 1 for true and 0 for false.
 */
export function boolPayload(value: boolean): Uint8Array {
    return new Uint8Array([value ? 1 : 0]);
}
