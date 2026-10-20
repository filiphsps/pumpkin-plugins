/**
 * Formats a distance in blocks as whole meters, or as kilometers with one decimal from 1000 meters.
 * It rounds before choosing the unit, so 999.6 blocks reads as `1.0km`, not `1000m`.
 *
 * @throws {RangeError} When the distance is not finite.
 */
export function formatDistance(blocks: number): string {
    const meters = Math.round(blocks);
    return meters < 1000 ? `${meters}m` : `${formatOneDecimal(blocks / 1000)}km`;
}

/**
 * Formats a number with one decimal place and no exponent, even past 1e21.
 *
 * @throws {RangeError} When the value is not finite.
 */
export function formatOneDecimal(value: number): string {
    if (!Number.isFinite(value)) throw new RangeError('Waypoint number is nonfinite');
    if (Math.abs(value) >= 1e21) return `${expandExponential(value.toString())}.0`;
    const formatted = value.toFixed(1);
    return formatted === '-0.0' ? '0.0' : formatted;
}

function expandExponential(value: string): string {
    const [coefficient = '', exponentText] = value.toLowerCase().split('e');
    if (exponentText === undefined) return coefficient;
    const exponent = Number(exponentText);
    const sign = coefficient.startsWith('-') ? '-' : '';
    const unsigned = sign ? coefficient.slice(1) : coefficient;
    const point = unsigned.indexOf('.') < 0 ? unsigned.length : unsigned.indexOf('.');
    const digits = unsigned.replace('.', '');
    const targetPoint = point + exponent;
    if (targetPoint <= 0) return `${sign}0.${'0'.repeat(-targetPoint)}${digits}`;
    if (targetPoint >= digits.length) return `${sign}${digits}${'0'.repeat(targetPoint - digits.length)}`;
    return `${sign}${digits.slice(0, targetPoint)}.${digits.slice(targetPoint)}`;
}
