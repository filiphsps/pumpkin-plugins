import { getDirectories } from 'wasi:filesystem/preopens@0.2.3';
import type { Descriptor } from 'wasi:filesystem/types@0.2.3';
import { atomicWrite } from './atomic-write.ts';
import type { DataFiles, FileInfo, FileKind, RandomAccessFile } from './files.ts';
import { wasiErrorCode } from './wasi-error.ts';
import { disposeWasiResource } from './wasi-resource.ts';

/** Most bytes read from a file in one call. */
const READ_CHUNK = 1 << 20;

const kindOf = (type: string): FileKind =>
    type === 'regular-file' ? 'file' : type === 'directory' ? 'directory' : 'other';

/** The plugin's data folder, which the server preopens as `data` when the plugin may use the filesystem. */
export class WasiDataDir implements DataFiles {
    private constructor(private readonly root: Descriptor) {}

    /**
     * Opens the data folder.
     * @returns The folder, or undefined when the server didn't mount it because `fs.*.data` isn't granted.
     */
    static open(): WasiDataDir | undefined {
        const mounts = getDirectories();
        const mount = mounts.find(([, path]) => path === 'data');
        for (const [descriptor] of mounts) {
            if (descriptor !== mount?.[0]) disposeWasiResource(descriptor);
        }
        return mount ? new WasiDataDir(mount[0]) : undefined;
    }

    /** Describes a path, or returns undefined when nothing is there. */
    stat(path: string): FileInfo | undefined {
        try {
            const stat = this.root.statAt({ symlinkFollow: true }, path);
            const time = stat.dataModificationTimestamp;
            return {
                kind: kindOf(stat.type),
                size: stat.size,
                modified: time ? time.seconds * 1000 + Math.floor(time.nanoseconds / 1e6) : 0
            };
        } catch (err) {
            if (wasiErrorCode(err) === 'no-entry') return undefined;
            throw err;
        }
    }

    /** Names of the entries in a folder. */
    list(directory: string): string[] {
        const folder = this.root.openAt({ symlinkFollow: true }, directory || '.', { directory: true }, { read: true });
        try {
            const entries = folder.readDirectory();
            const names: string[] = [];
            try {
                for (let entry = entries.readDirectoryEntry(); entry; entry = entries.readDirectoryEntry()) {
                    names.push(entry.name);
                }
            } finally {
                disposeWasiResource(entries);
            }
            return names;
        } finally {
            disposeWasiResource(folder);
        }
    }

    /** Reads a whole file. */
    readFile(path: string): Uint8Array {
        const file = this.open(path);
        try {
            const out = new Uint8Array(file.size);
            let offset = 0;
            while (offset < out.length) {
                const chunk = file.read(offset, Math.min(READ_CHUNK, out.length - offset));
                if (chunk.length === 0) break;
                out.set(chunk, offset);
                offset += chunk.length;
            }
            return offset === out.length ? out : out.subarray(0, offset);
        } finally {
            file.close();
        }
    }

    /** Writes a file, replacing any existing one in a single step so readers never see half a file. */
    writeFile(path: string, content: Uint8Array): void {
        atomicWrite(this.root, path, content);
    }

    /** Creates a folder and any missing parents. Does nothing if it already exists. */
    createDirectory(path: string): void {
        if (path.startsWith('/')) throw new TypeError('Data paths must be relative');
        const parts = path.split('/').filter(Boolean);
        for (let i = 1; i <= parts.length; i++) {
            try {
                this.root.createDirectoryAt(parts.slice(0, i).join('/'));
            } catch (err) {
                if (wasiErrorCode(err) !== 'exist' || this.stat(parts.slice(0, i).join('/'))?.kind !== 'directory') {
                    throw err;
                }
            }
        }
    }

    /** Deletes a file or an empty folder. Does nothing if it doesn't exist. */
    remove(path: string): void {
        try {
            // Inspect the entry itself so dangling links and links to directories can be removed.
            const { type } = this.root.statAt({}, path);
            if (type === 'directory') this.root.removeDirectoryAt(path);
            else this.root.unlinkFileAt(path);
        } catch (error) {
            if (wasiErrorCode(error) !== 'no-entry') throw error;
        }
    }

    /** Opens a file for random-access reads. */
    open(path: string): RandomAccessFile {
        const file = this.root.openAt({ symlinkFollow: true }, path, {}, { read: true });
        try {
            const { size, type } = file.stat();
            if (type !== 'regular-file') throw new Error(`${path} is not a regular file`);
            let closed = false;
            return {
                size,
                read: (offset, length) => {
                    if (closed) throw new Error('File is closed');
                    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
                        throw new RangeError('Read offset and length must be nonnegative safe integers');
                    }
                    return file.read(length, offset)[0];
                },
                close: () => {
                    if (closed) return;
                    closed = true;
                    disposeWasiResource(file);
                }
            };
        } catch (error) {
            disposeWasiResource(file);
            throw error;
        }
    }
}
