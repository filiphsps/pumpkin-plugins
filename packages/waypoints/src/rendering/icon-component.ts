import { BLOCK_ICON_SPRITES } from './icon-sprites.ts';

/** Adds a centered icon line without passing sprite objects through Pumpkin's text parser. */
export function appendWaypointIcon(labelNbt: Uint8Array, icon: string | undefined): Uint8Array {
    if (icon === undefined) return labelNbt;
    if (labelNbt[0] !== 10) throw new TypeError('Waypoint label must be a network-NBT compound.');
    const [namespace, path] = icon.split(':');
    const spritePath =
        namespace === 'minecraft' && Object.hasOwn(BLOCK_ICON_SPRITES, path) ? BLOCK_ICON_SPRITES[path] : undefined;
    const atlas = spritePath?.startsWith('block/') ? 'minecraft:blocks' : 'minecraft:items';
    const sprite = `${namespace}:${spritePath ?? `item/${path}`}`;
    // An unnamed root compound containing three compound children: label, line break, sprite.
    // Keeping the host's label as a child preserves its formatting and modified-UTF-8 encoding.
    return Uint8Array.from([
        10,
        8,
        ...encodeString('text'),
        0,
        0,
        9,
        ...encodeString('extra'),
        10,
        0,
        0,
        0,
        3,
        ...labelNbt.subarray(1),
        8,
        ...encodeString('text'),
        ...encodeString('\n'),
        0,
        8,
        ...encodeString('type'),
        ...encodeString('object'),
        8,
        ...encodeString('object'),
        ...encodeString('atlas'),
        8,
        ...encodeString('atlas'),
        ...encodeString(atlas),
        8,
        ...encodeString('sprite'),
        ...encodeString(sprite),
        0,
        0
    ]);
}

/** Writes NBT's unsigned-short length prefix; sprite identifiers and field names are ASCII. */
function encodeString(value: string): number[] {
    return [value.length >>> 8, value.length & 255, ...Array.from(value, (character) => character.charCodeAt(0))];
}
