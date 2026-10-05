import type { DataFiles, FileInfo, RandomAccessFile } from '../files.ts';

/** An in-memory data folder that counts reads, so tests can check what gets re-read. */
export class MemoryFiles implements DataFiles {
    private readonly files = new Map<string, { content: Uint8Array; modified: number }>();
    private readonly directories = new Set<string>(['']);
    /** How many times each file was read in full. */
    readonly reads = new Map<string, number>();
    private clock = 1000;

    /** Adds or replaces a file, bumping its modification time. */
    put(path: string, content: Uint8Array | string): this {
        const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content.slice();
        if (this.directories.has(path)) throw fsError('is-directory');
        this.createDirectory(parent(path));
        this.files.set(path, { content: bytes, modified: this.clock++ });
        return this;
    }

    /** Deletes a file or a folder. */
    remove(path: string): void {
        if (this.directories.has(path) && this.list(path).length > 0) throw fsError('not-empty');
        if (path === '') throw fsError('not-permitted');
        this.files.delete(path);
        this.directories.delete(path);
    }

    /** Text of a file, for assertions. */
    text(path: string): string | undefined {
        const file = this.files.get(path);
        return file && new TextDecoder().decode(file.content);
    }

    stat(path: string): FileInfo | undefined {
        const file = this.files.get(path);
        if (file) return { kind: 'file', size: file.content.length, modified: file.modified };
        return this.directories.has(path) ? { kind: 'directory', size: 0, modified: 0 } : undefined;
    }

    list(directory: string): string[] {
        if (!this.directories.has(directory)) throw fsError('no-entry');
        const prefix = directory === '' ? '' : `${directory}/`;
        const names = new Set<string>();
        for (const path of [...this.files.keys(), ...this.directories]) {
            if (path.startsWith(prefix) && path !== directory && path !== '')
                names.add(path.slice(prefix.length).split('/')[0]);
        }
        return [...names];
    }

    readFile(path: string): Uint8Array {
        const file = this.files.get(path);
        if (!file) throw fsError('no-entry');
        this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
        return file.content.slice();
    }

    writeFile(path: string, content: Uint8Array): void {
        if (!this.directories.has(parent(path))) throw fsError('no-entry');
        this.put(path, content);
    }

    createDirectory(path: string): void {
        const parts = path.split('/').filter(Boolean);
        for (let i = 1; i <= parts.length; i++) {
            const directory = parts.slice(0, i).join('/');
            if (this.files.has(directory)) throw fsError('not-directory');
            this.directories.add(directory);
        }
    }

    open(path: string): RandomAccessFile {
        const file = this.files.get(path);
        if (!file) throw fsError('no-entry');
        let closed = false;
        return {
            size: file.content.length,
            read: (offset, length) => {
                if (closed) throw new Error('File is closed');
                if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
                    throw new RangeError('Read offset and length must be nonnegative safe integers');
                }
                return file.content.slice(offset, offset + length);
            },
            close: () => {
                closed = true;
            }
        };
    }
}

function parent(path: string): string {
    return path.split('/').slice(0, -1).join('/');
}

function fsError(code: string): Error {
    return Object.assign(new Error(code), { payload: code });
}
