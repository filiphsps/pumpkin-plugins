/*
 * Adapted from DH Support. Copyright (C) 2024 Jim C K Flaten.
 * Protocol adaptations reference Distant Horizons core, Copyright (C) 2020 James Seibel,
 * originally under LGPL-3.0-only (see ../../LICENSE.LESSER.txt).
 * Changes for Pumpkin made in October 2026.
 * SPDX-License-Identifier: GPL-3.0-or-later
 * This program is free software under GNU GPL version 3 or any later version.
 * Distributed WITHOUT ANY WARRANTY; see ../../LICENSE.
 */
/** Writes the big-endian integers and UTF-8 strings used by DH. */
export class Writer {
    private data = new Uint8Array(64);
    private view = new DataView(this.data.buffer);
    private length = 0;
    /** Appends one byte. */
    byte(value: number): this {
        this.reserve(1);
        this.data[this.length++] = value;
        return this;
    }
    /** Appends a boolean. */
    bool(value: boolean): this {
        return this.byte(value ? 1 : 0);
    }
    /** Appends a 16-bit integer. */
    short(value: number): this {
        this.reserve(2);
        this.view.setUint16(this.length, value & 0xffff);
        this.length += 2;
        return this;
    }
    /** Appends a 32-bit integer. */
    int(value: number): this {
        this.reserve(4);
        this.view.setUint32(this.length, value >>> 0);
        this.length += 4;
        return this;
    }
    /** Appends an exact 64-bit bit pattern as two 32-bit words. */
    words(high: number, low: number): this {
        return this.int(high).int(low);
    }
    /** Appends a nonnegative, safe 64-bit timestamp. */
    timestamp(value: number): this {
        if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid timestamp');
        return this.words(Math.floor(value / 4294967296), value % 4294967296);
    }
    /** Appends bytes without a length prefix. */
    bytes(value: Uint8Array): this {
        this.reserve(value.length);
        this.data.set(value, this.length);
        this.length += value.length;
        return this;
    }
    /** Appends bytes prefixed by a 32-bit length. */
    blob(value: Uint8Array): this {
        return this.int(value.length).bytes(value);
    }
    /** Appends UTF-8 prefixed by its byte length, matching the DH protocol. */
    string(value: string): this {
        const start = this.length;
        this.short(0);
        for (const character of value) {
            let c = character.codePointAt(0) ?? 0;
            if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
            if (c < 128) this.byte(c);
            else if (c < 2048) this.byte(192 | (c >>> 6)).byte(128 | (c & 63));
            else if (c < 65536)
                this.byte(224 | (c >>> 12))
                    .byte(128 | ((c >>> 6) & 63))
                    .byte(128 | (c & 63));
            else
                this.byte(240 | (c >>> 18))
                    .byte(128 | ((c >>> 12) & 63))
                    .byte(128 | ((c >>> 6) & 63))
                    .byte(128 | (c & 63));
        }
        const size = this.length - start - 2;
        if (size > 65535) {
            this.length = start;
            throw new RangeError('DH string is too long');
        }
        this.view.setUint16(start, size);
        return this;
    }
    /** Returns a copy of the encoded bytes. */
    finish(): Uint8Array {
        return this.data.slice(0, this.length);
    }
    private reserve(size: number): void {
        const needed = this.length + size;
        if (needed <= this.data.length) return;
        let capacity = this.data.length * 2;
        while (capacity < needed) capacity *= 2;
        const data = new Uint8Array(capacity);
        data.set(this.data.subarray(0, this.length));
        this.data = data;
        this.view = new DataView(data.buffer);
    }
}

/** Reads bounded DH messages without depending on browser or Node globals. */
export class Reader {
    private offset = 0;
    constructor(private readonly data: Uint8Array) {}
    /** Reads one unsigned byte. */
    byte(): number {
        const byte = this.data[this.offset];
        if (byte === undefined) throw new RangeError('Truncated DH message');
        this.offset++;
        return byte;
    }
    /** Reads a boolean and rejects invalid encodings. */
    bool(): boolean {
        const b = this.byte();
        if (b > 1) throw new RangeError('Invalid boolean');
        return b === 1;
    }
    /** Reads an unsigned 16-bit integer. */
    short(): number {
        return this.byte() * 256 + this.byte();
    }
    /** Reads a signed 32-bit integer. */
    int(): number {
        return (this.short() * 65536 + this.short()) | 0;
    }
    /** Reads an exact 64-bit value as two unsigned words. */
    words(): { high: number; low: number } {
        return { high: this.int() >>> 0, low: this.int() >>> 0 };
    }
    /** Reads a nonnegative timestamp that JavaScript can represent exactly. */
    timestamp(): number {
        const { high, low } = this.words();
        const n = high * 4294967296 + low;
        if (!Number.isSafeInteger(n)) throw new RangeError('Invalid timestamp');
        return n;
    }
    /** Reads a bounded byte slice. */
    bytes(length: number): Uint8Array {
        if (length < 0 || length > this.data.length - this.offset) throw new RangeError('Truncated DH message');
        const result = this.data.slice(this.offset, this.offset + length);
        this.offset += length;
        return result;
    }
    /** Reads a length-prefixed UTF-8 string, rejecting malformed input. */
    string(): string {
        const bytes = this.bytes(this.short());
        let result = '';
        for (let i = 0; i < bytes.length; ) {
            const first = bytes[i];
            if (first === undefined) throw new RangeError('Invalid UTF-8');
            i++;
            let c = first;
            let count = 0;
            let minimum = 0;
            if (first >= 0xc2 && first <= 0xdf) {
                c = first & 31;
                count = 1;
                minimum = 128;
            } else if (first >= 0xe0 && first <= 0xef) {
                c = first & 15;
                count = 2;
                minimum = 2048;
            } else if (first >= 0xf0 && first <= 0xf4) {
                c = first & 7;
                count = 3;
                minimum = 65536;
            } else if (first > 127) throw new RangeError('Invalid UTF-8');
            for (let j = 0; j < count; j++) {
                const b = bytes[i++];
                if (b === undefined || (b & 192) !== 128) throw new RangeError('Invalid UTF-8');
                c = c * 64 + (b & 63);
            }
            if (c < minimum || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) throw new RangeError('Invalid UTF-8');
            result += String.fromCodePoint(c);
        }
        return result;
    }
    /** Rejects extra bytes after the expected message. */
    end(): void {
        if (this.offset !== this.data.length) throw new RangeError('Trailing DH message bytes');
    }
}
