/** Encodes a 32-bit floating-point value in big-endian byte order. */
export function float32be(value: number): Uint8Array {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value);
    return bytes;
}

/** Encodes a boolean as one byte: 1 for true and 0 for false. */
export function bool(value: boolean): Uint8Array {
    return new Uint8Array([value ? 1 : 0]);
}
