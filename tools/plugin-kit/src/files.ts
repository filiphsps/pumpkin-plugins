/** What a path in the data folder is. */
export type FileKind = 'file' | 'directory' | 'other';

/** Metadata of a file or folder in the data folder. */
export interface FileInfo {
    /** Whether it is a file, a folder or something else. */
    kind: FileKind;
    /** Last modification, in milliseconds since the epoch. */
    modified: number;
    /** Size in bytes. */
    size: number;
}

/** A file opened for reads at arbitrary offsets. */
export interface RandomAccessFile {
    /** Releases the file. */
    close(): void;
    /** Reads up to `length` bytes starting at `offset`. Returns fewer at the end of the file. */
    read(offset: number, length: number): Uint8Array;
    /** Size in bytes when the file was opened. */
    readonly size: number;
}

/** The plugin's private data folder. Every path is relative to it and uses `/` separators. */
export interface DataFiles {
    /** Creates a folder and any missing parents. Does nothing if it already exists. */
    createDirectory(path: string): void;
    /** Names of the entries in a folder. */
    list(directory: string): string[];
    /** Opens a file for random-access reads. */
    open(path: string): RandomAccessFile;
    /** Reads a whole file. */
    readFile(path: string): Uint8Array;
    /** Deletes a file or an empty folder. Does nothing if it doesn't exist. */
    remove(path: string): void;
    /** Describes a path, or returns undefined when nothing is there. */
    stat(path: string): FileInfo | undefined;
    /** Writes a file, replacing any existing one in a single step so readers never see half a file. */
    writeFile(path: string, content: Uint8Array): void;
}
