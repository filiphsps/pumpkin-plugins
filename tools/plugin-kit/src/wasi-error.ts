/**
 * The code of a WASI error. Filesystem and socket errors carry a string such as `no-entry` or
 * `address-in-use`; stream errors carry an object such as `{ tag: 'closed' }`.
 * @param err - Whatever was thrown.
 * @returns The code, or undefined when the error isn't a WASI one.
 */
export function wasiErrorCode(err: unknown): string | undefined {
    const payload = (err as { payload?: unknown } | null)?.payload;
    if (typeof payload === 'string') return payload;
    const tag = (payload as { tag?: unknown } | null | undefined)?.tag;
    return typeof tag === 'string' ? tag : undefined;
}
