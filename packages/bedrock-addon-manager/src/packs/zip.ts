import type { RandomAccessFile } from '@pumpkin-plugins/plugin-kit/files';
import { inflateSync, strFromU8 } from 'fflate';

/** Something a zip archive can be read from at arbitrary offsets: an open file, or bytes in memory. */
export type ByteSource = Pick<RandomAccessFile, 'read' | 'size'>;

/** One file in a zip archive, as its central directory describes it. */
export interface ZipEntry {
    compressedSize: number;
    localHeaderOffset: number;
    method: number;
    /** Path inside the archive, with `/` separators. */
    name: string;
    /** Size once inflated, in bytes. */
    size: number;
}

/** The archive can't be read as a zip. */
export class ZipError extends Error {}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_RECORD_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const STORED = 0;
const DEFLATED = 8;

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;

/** Wraps bytes that are already in memory. */
export function bytesSource(bytes: Uint8Array): ByteSource {
    return { size: bytes.length, read: (offset, length) => bytes.subarray(offset, offset + length) };
}

/** Reads exactly `length` bytes, or throws when the archive ends first. */
function readExactly(source: ByteSource, offset: number, length: number): Uint8Array {
    if (offset < 0 || offset + length > source.size) throw new ZipError('points past the end of the archive');
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
        const chunk = source.read(offset + done, length - done);
        if (chunk.length === 0) throw new ZipError('ended early');
        out.set(chunk, done);
        done += chunk.length;
    }
    return out;
}

/**
 * Lists the files in a zip archive from its central directory, reading only the end of the archive
 * and the directory itself. ZIP64 archives are not supported.
 * @throws {ZipError} When the archive has no readable central directory.
 */
export function listZip(source: ByteSource): ZipEntry[] {
    const tailLength = Math.min(source.size, END_RECORD_SIZE + MAX_COMMENT_SIZE);
    const tail = readExactly(source, source.size - tailLength, tailLength);
    let end = -1;
    for (let at = tail.length - END_RECORD_SIZE; at >= 0; at--) {
        if (u32(tail, at) === END_OF_CENTRAL_DIRECTORY) {
            end = at;
            break;
        }
    }
    if (end < 0) throw new ZipError('has no central directory');

    const count = u16(tail, end + 10);
    const directory = readExactly(source, u32(tail, end + 16), u32(tail, end + 12));
    const entries: ZipEntry[] = [];
    let at = 0;
    for (let i = 0; i < count; i++) {
        if (at + 46 > directory.length || u32(directory, at) !== CENTRAL_DIRECTORY_HEADER) {
            throw new ZipError('has a damaged central directory');
        }
        const nameLength = u16(directory, at + 28);
        entries.push({
            method: u16(directory, at + 10),
            compressedSize: u32(directory, at + 20),
            size: u32(directory, at + 24),
            localHeaderOffset: u32(directory, at + 42),
            name: strFromU8(directory.subarray(at + 46, at + 46 + nameLength)),
        });
        at += 46 + nameLength + u16(directory, at + 30) + u16(directory, at + 32);
    }
    return entries;
}

/**
 * Reads and inflates one file of a zip archive. At most `entry.size` bytes are produced.
 * @throws {ZipError} When the entry can't be read or uses a compression method other than store or deflate.
 */
export function readZipEntry(source: ByteSource, entry: ZipEntry): Uint8Array {
    const header = readExactly(source, entry.localHeaderOffset, 30);
    if (u32(header, 0) !== LOCAL_FILE_HEADER) throw new ZipError(`has a damaged header for ${entry.name}`);
    const data = readExactly(
        source,
        entry.localHeaderOffset + 30 + u16(header, 26) + u16(header, 28),
        entry.compressedSize,
    );
    if (entry.method === STORED) return data;
    if (entry.method !== DEFLATED) throw new ZipError(`uses an unsupported compression method for ${entry.name}`);
    try {
        return inflateSync(data, { out: new Uint8Array(entry.size) });
    } catch {
        throw new ZipError(`could not inflate ${entry.name}`);
    }
}
