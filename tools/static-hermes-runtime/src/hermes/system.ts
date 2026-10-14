import { type ExecFileSyncOptions, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

/** Injectable wrappers for running Hermes setup commands and capturing their output. */
export interface HermesProcessRunner {
    /** Capture command output as bytes without decoding it. */
    buffer(command: string, args: readonly string[], options?: ExecFileSyncOptions): Buffer;
    /** Capture UTF-8 output and remove its final line ending. */
    output(command: string, args: readonly string[], options?: ExecFileSyncOptions): string;
    /** Run a command with inherited output unless overridden in the options. */
    run(command: string, args: readonly string[], options?: ExecFileSyncOptions): void;
}

/** Default process runner used by Hermes preparation and build operations. */
export const hermesProcess: HermesProcessRunner = {
    run(command, args, options = {}) {
        execFileSync(command, [...args], { stdio: 'inherit', ...options });
    },
    output(command, args, options = {}) {
        return (execFileSync(command, [...args], { ...options, encoding: 'utf8' }) as string).replace(/\r?\n$/, '');
    },
    buffer(command, args, options = {}) {
        return execFileSync(command, [...args], { ...options, encoding: 'buffer' }) as Buffer;
    },
};

/** Filesystem operations used by Hermes preparation, with an injectable test boundary. */
export interface HermesFileSystem {
    /** Close an open file descriptor. */
    closeSync(fd: number): void;
    /** Test whether a file or directory exists. */
    existsSync(path: fs.PathLike): boolean;
    /** Read file metadata directly from an open file descriptor. */
    fstatSync(fd: number): fs.Stats;
    /** Read file metadata without following a symbolic link. */
    lstatSync(path: fs.PathLike): fs.Stats;
    /** Create a directory, optionally including its parents. */
    mkdirSync(path: fs.PathLike, options?: fs.MakeDirectoryOptions): string | undefined;
    /** Open a file with the requested flags and return its descriptor. */
    openSync(path: fs.PathLike, flags: fs.OpenMode): number;
    /** List the names of entries in a directory. */
    readdirSync(path: fs.PathLike): string[];
    /** Read a file as text using the requested encoding. */
    readFileSync(path: fs.PathOrFileDescriptor, encoding: BufferEncoding): string;
    /** Read a file as raw bytes. */
    readFileSync(path: fs.PathOrFileDescriptor): Buffer;
    /** Rename a file or directory. */
    renameSync(oldPath: fs.PathLike, newPath: fs.PathLike): void;
    /** Remove a file or directory, optionally ignoring missing paths and recursing. */
    rmSync(path: fs.PathLike, options?: fs.RmOptions): void;
    /** Read file metadata, including its size and modification time. */
    statSync(path: fs.PathLike): fs.Stats;
    /** Write text or bytes to a file, with optional open flags and encoding. */
    writeFileSync(
        path: fs.PathOrFileDescriptor,
        data: string | NodeJS.ArrayBufferView,
        options?: fs.WriteFileOptions,
    ): void;
}

/** Default filesystem implementation used by Hermes preparation and build operations. */
export const hermesFileSystem: HermesFileSystem = fs;
