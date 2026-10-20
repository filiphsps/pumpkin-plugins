/** World names shared by the permission, player, chat, region and storage fixtures. */
export const PERMISSION_WORLDS = ['survival', 'spawn', 'creative'];

/** Returns whether a parsed JSON value is a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
