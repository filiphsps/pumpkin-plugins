import { describe, expect, it } from 'vitest';
import { appendWaypointIcon } from './icon-component.ts';

describe('waypoint icon component', () => {
    it('uses the Java client object type discriminator without a namespace', () => {
        const encoded = Buffer.from(appendWaypointIcon(Uint8Array.of(10, 0), 'minecraft:pumpkin_pie'));
        // NBT string tag 8, four-character key "type", then its unsigned-short value length.
        const typeOffset = encoded.indexOf(Buffer.from('08000474797065', 'hex')) + 7;
        const length = encoded.readUInt16BE(typeOffset);
        expect(encoded.subarray(typeOffset + 2, typeOffset + 2 + length).toString()).toBe('object');
    });
    it('wraps label, newline and untinted atlas sprite in a centered multiline component', () => {
        const label = Uint8Array.from(Buffer.from('0a0800047465787400044761746500', 'hex'));
        const encoded = appendWaypointIcon(label, 'minecraft:poppy');
        expect(Buffer.from(encoded).toString('hex')).toBe(
            '0a08000474657874000009000565787472610a000000030800047465787400044761746500' +
                '0800047465787400010a00' +
                '0800047479706500066f626a656374' +
                '0800066f626a656374000561746c6173' +
                '08000561746c617300106d696e6563726166743a626c6f636b73' +
                '08000673707269746500156d696e6563726166743a626c6f636b2f706f7070790000'
        );
    });

    it('leaves labels without icons byte-identical', () => {
        const label = Uint8Array.of(10, 0);
        expect(appendWaypointIcon(label, undefined)).toBe(label);
    });

    it.each(['example:flower', 'minecraft:constructor'])('uses an item sprite for an unmapped ID %s', (icon) => {
        const encoded = appendWaypointIcon(Uint8Array.of(10, 0), icon);
        const [namespace, path] = icon.split(':');
        expect(new TextDecoder().decode(encoded)).toContain(`${namespace}:item/${path}`);
    });
});
