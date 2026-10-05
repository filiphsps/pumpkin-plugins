import { getDirectories } from 'wasi:filesystem/preopens@0.2.3';
import type { Descriptor } from 'wasi:filesystem/types@0.2.3';
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
        const mount = getDirectories().find(([, path]) => path === 'data');
        return mount ? new WasiDataDir(mount[0]) : undefined;
    }

    /** {@inheritDoc DataFiles.stat} */
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

    /** {@inheritDoc DataFiles.list} */
    list(directory: string): string[] {
        const folder = this.root.openAt({ symlinkFollow: true }, directory, { directory: true }, { read: true });
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

    /** {@inheritDoc DataFiles.readFile} */
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

    /** {@inheritDoc DataFiles.writeFile} */
    writeFile(path: string, content: Uint8Array): void {
        const temp = `${path}.tmp`;
        const file = this.root.openAt({}, temp, { create: true, truncate: true }, { write: true });
        try {
            for (let offset = 0; offset < content.length; ) {
                const written = file.write(content.subarray(offset), offset);
                if (written === 0) throw new Error(`could not write ${path}`);
                offset += written;
            }
        } catch (err) {
            disposeWasiResource(file);
            this.root.unlinkFileAt(temp);
            throw err;
        }
        disposeWasiResource(file);
        this.root.renameAt(temp, this.root, path);
    }

    /** {@inheritDoc DataFiles.createDirectory} */
    createDirectory(path: string): void {
        const parts = path.split('/').filter(Boolean);
        for (let i = 1; i <= parts.length; i++) {
            try {
                this.root.createDirectoryAt(parts.slice(0, i).join('/'));
            } catch (err) {
                if (wasiErrorCode(err) !== 'exist') throw err;
            }
        }
    }

    /** {@inheritDoc DataFiles.remove} */
    remove(path: string): void {
        const kind = this.stat(path)?.kind;
        if (kind === 'directory') this.root.removeDirectoryAt(path);
        else if (kind) this.root.unlinkFileAt(path);
    }

    /** {@inheritDoc DataFiles.open} */
    open(path: string): RandomAccessFile {
        const file = this.root.openAt({ symlinkFollow: true }, path, {}, { read: true });
        const { size } = file.stat();
        return {
            size,
            read: (offset, length) => file.read(length, offset)[0],
            close: () => disposeWasiResource(file)
        };
    }
}
