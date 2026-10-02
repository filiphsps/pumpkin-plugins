/** Name of the custom section that carries the signed metadata JSON. */
export const METADATA_SECTION = 'pumpkin.metadata';

/** Name of the custom section that carries the signature envelope JSON. */
export const SIGNATURE_SECTION = 'wasm_signature';

/** Custom sections Pumpkin treats as signing data and strips before signing or verifying. */
export const SIGNING_SECTIONS: readonly string[] = [METADATA_SECTION, SIGNATURE_SECTION, 'pumpkin.signature'];

const MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
const HEADER_LENGTH = 8;

/** One section of a wasm binary. Offsets are into the original bytes. */
export interface WasmSection {
    /** Section id; 0 is a custom section. */
    id: number;
    /** Offset of the id byte. */
    start: number;
    /** Offset just past the last payload byte. */
    end: number;
    /** Custom sections only: the section name. */
    name?: string;
    /** Custom sections only: the section data, after the name. */
    data?: Uint8Array;
}

/** A wasm binary split into the part that gets signed and the signing sections cut off its end. */
export interface StrippedWasm {
    /** The binary up to and including the last section that isn't a signing section. */
    clean: Buffer;
    /** The signing custom sections that followed it, in file order. */
    trailing: WasmSection[];
}

function isSigningSection(section: WasmSection): boolean {
    return section.id === 0 && section.name !== undefined && SIGNING_SECTIONS.includes(section.name);
}

function readLeb128(bytes: Uint8Array, offset: number): { value: number; next: number } {
    let value = 0;
    let shift = 0;
    let pos = offset;
    for (;;) {
        if (pos >= bytes.length) throw new Error('truncated LEB128 value');
        if (shift > 28) throw new Error('LEB128 value is too large');
        const byte = bytes[pos++] as number;
        value += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) return { value, next: pos };
        shift += 7;
    }
}

function encodeLeb128(value: number): Buffer {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
        throw new Error(`cannot encode ${value} as LEB128`);
    const out: number[] = [];
    let rest = value;
    do {
        const byte = rest % 128;
        rest = Math.floor(rest / 128);
        out.push(rest > 0 ? byte | 0x80 : byte);
    } while (rest > 0);
    return Buffer.from(out);
}

/**
 * Splits a wasm binary into its sections. Core modules and components share the framing (an 8-byte
 * header, then sections), and the version bytes aren't checked, so both work.
 * @param wasm - The binary.
 * @returns Every section in file order; custom sections carry their name and data.
 * @throws {Error} When the bytes aren't a well-formed wasm binary.
 */
export function parseSections(wasm: Uint8Array): WasmSection[] {
    if (wasm.length < HEADER_LENGTH || !MAGIC.equals(wasm.subarray(0, MAGIC.length))) {
        throw new Error('not a WebAssembly binary (bad magic number)');
    }
    const sections: WasmSection[] = [];
    let pos = HEADER_LENGTH;
    while (pos < wasm.length) {
        const start = pos;
        const id = wasm[pos++] as number;
        const size = readLeb128(wasm, pos);
        const payload = size.next;
        const end = payload + size.value;
        if (end > wasm.length) throw new Error(`section at offset ${start} runs past the end of the file`);
        const section: WasmSection = { id, start, end };
        if (id === 0) {
            const nameLength = readLeb128(wasm, payload);
            const nameEnd = nameLength.next + nameLength.value;
            if (nameEnd > end) throw new Error(`custom section at offset ${start} has a name longer than the section`);
            section.name = Buffer.from(wasm.subarray(nameLength.next, nameEnd)).toString('utf8');
            section.data = wasm.subarray(nameEnd, end);
        }
        sections.push(section);
        pos = end;
    }
    return sections;
}

/**
 * Cuts the signing custom sections off the end of a wasm binary. Signing sections that sit before
 * other sections are kept, as Pumpkin does.
 * @param wasm - The binary, signed or not.
 * @returns The clean binary and the signing sections that were removed.
 * @throws {Error} When the bytes aren't a well-formed wasm binary.
 */
export function stripSignature(wasm: Uint8Array): StrippedWasm {
    const sections = parseSections(wasm);
    let keep = sections.length;
    while (keep > 0 && isSigningSection(sections[keep - 1] as WasmSection)) keep--;
    const cut = keep === 0 ? HEADER_LENGTH : (sections[keep - 1] as WasmSection).end;
    return { clean: Buffer.from(wasm.subarray(0, cut)), trailing: sections.slice(keep) };
}

/**
 * Encodes a custom section.
 * @param name - The section name.
 * @param data - The section data.
 * @returns The section bytes: id 0, size, name length, name, data.
 */
export function customSection(name: string, data: Uint8Array): Buffer {
    const nameBytes = Buffer.from(name, 'utf8');
    const body = Buffer.concat([encodeLeb128(nameBytes.length), nameBytes, data]);
    return Buffer.concat([Buffer.from([0x00]), encodeLeb128(body.length), body]);
}

/**
 * Appends custom sections to a wasm binary, in order.
 * @param wasm - The binary to extend.
 * @param sections - The sections to append, as `[name, data]` pairs.
 * @returns A new binary.
 */
export function appendCustomSections(wasm: Uint8Array, sections: ReadonlyArray<readonly [string, Uint8Array]>): Buffer {
    return Buffer.concat([wasm, ...sections.map(([name, data]) => customSection(name, data))]);
}
