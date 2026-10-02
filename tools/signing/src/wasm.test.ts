import { describe, expect, it } from 'vitest';
import { minimalWasm } from './testing/fixtures.ts';
import { appendCustomSections, customSection, parseSections, stripSignature } from './wasm.ts';

describe('customSection', () => {
    it('encodes id, size, name length, name and data', () => {
        const bytes = customSection('ab', Buffer.from([1, 2, 3]));
        expect([...bytes]).toEqual([0x00, 0x06, 0x02, 0x61, 0x62, 1, 2, 3]);
    });

    it('uses multi-byte LEB128 sizes for large data', () => {
        const bytes = customSection('x', Buffer.alloc(300));
        expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0xae, 0x02, 0x01]);
        expect(parseSections(Buffer.concat([minimalWasm(), bytes])).at(-1)?.data?.length).toBe(300);
    });
});

describe('parseSections', () => {
    it('lists the sections of a minimal module', () => {
        const sections = parseSections(minimalWasm());
        expect(sections.map((s) => s.id)).toEqual([1, 0]);
        expect(sections[1]?.name).toBe('name');
        expect(Buffer.from(sections[1]?.data ?? []).toString()).toBe('hello');
    });

    it('accepts a bare header', () => {
        expect(parseSections(minimalWasm().subarray(0, 8))).toEqual([]);
    });

    it('accepts a component header (version 0x0d, layer 1)', () => {
        const component = Buffer.from(minimalWasm());
        component.set([0x0d, 0x00, 0x01, 0x00], 4);
        expect(parseSections(component).map((s) => s.id)).toEqual([1, 0]);
    });

    it('rejects bad magic, truncation and sections running past the end', () => {
        expect(() => parseSections(Buffer.from('nope'))).toThrow(/not a WebAssembly/);
        expect(() => parseSections(minimalWasm().subarray(0, 12))).toThrow(/past the end/);
        expect(() => parseSections(Buffer.concat([minimalWasm().subarray(0, 8), Buffer.from([1])]))).toThrow(/LEB128/);
    });

    it('rejects a custom section whose name is longer than the section', () => {
        const bad = Buffer.concat([minimalWasm().subarray(0, 8), Buffer.from([0x00, 0x02, 0x05, 0x61])]);
        expect(() => parseSections(bad)).toThrow(/name longer/);
    });
});

describe('stripSignature', () => {
    it('leaves an unsigned module alone', () => {
        const { clean, trailing } = stripSignature(minimalWasm());
        expect(clean.equals(minimalWasm())).toBe(true);
        expect(trailing).toEqual([]);
    });

    it('cuts every trailing signing section', () => {
        const signed = appendCustomSections(minimalWasm(), [
            ['pumpkin.metadata', Buffer.from('{}')],
            ['pumpkin.signature', Buffer.from('old')],
            ['wasm_signature', Buffer.from('{}')]
        ]);
        const { clean, trailing } = stripSignature(signed);
        expect(clean.equals(minimalWasm())).toBe(true);
        expect(trailing.map((s) => s.name)).toEqual(['pumpkin.metadata', 'pumpkin.signature', 'wasm_signature']);
    });

    it('keeps signing sections that are followed by another section', () => {
        const wasm = appendCustomSections(minimalWasm(), [
            ['pumpkin.metadata', Buffer.from('{}')],
            ['other', Buffer.from('x')]
        ]);
        expect(stripSignature(wasm).clean.equals(wasm)).toBe(true);
    });

    it('keeps other trailing custom sections', () => {
        const wasm = appendCustomSections(minimalWasm(), [['producers', Buffer.from('x')]]);
        expect(stripSignature(wasm).clean.equals(wasm)).toBe(true);
    });

    it('reduces a header followed only by signing sections to the header', () => {
        const wasm = appendCustomSections(minimalWasm().subarray(0, 8), [['wasm_signature', Buffer.from('{}')]]);
        expect(stripSignature(wasm).clean.length).toBe(8);
    });
});
