/**
 * Converts a WASI `u64`, which arrives as a bigint, to a number.
 * @param value - The value from a WASI call, such as a file size or a writable byte count.
 * @param label - What the value is, for the error message.
 * @throws {RangeError} When the value is negative or above `Number.MAX_SAFE_INTEGER`.
 */
export function toSafeNumber(value: bigint, label: string): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw new RangeError(`${label} exceeds JavaScript's safe integer range`);
    }
    return number;
}
