import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ directories: vi.fn() }));
vi.mock('wasi:filesystem/preopens@0.2.3', () => ({ getDirectories: host.directories }));

import { WasiDataDir } from './data-dir.ts';

const error = (payload: string) => Object.assign(new Error(payload), { payload });
function fixture() {
    const entries = { readDirectoryEntry: vi.fn().mockReturnValue(undefined), drop: vi.fn() };
    const file = {
        stat: vi.fn(() => ({ type: 'regular-file', size: 3n })),
        read: vi.fn(() => [new Uint8Array([1, 2, 3]), true]),
        write: vi.fn((bytes: Uint8Array, _offset: bigint) => BigInt(bytes.length)),
        readDirectory: vi.fn(() => entries),
        drop: vi.fn()
    };
    const root = {
        openAt: vi.fn((_flags: unknown, _path: string, _open: unknown, _descriptor: unknown) => file),
        statAt: vi.fn((_flags: unknown, _path: string) => ({ type: 'regular-file', size: 3n })),
        renameAt: vi.fn(),
        unlinkFileAt: vi.fn(),
        removeDirectoryAt: vi.fn(),
        createDirectoryAt: vi.fn(),
        drop: vi.fn()
    };
    host.directories.mockReturnValue([[root, 'data']]);
    const dir = WasiDataDir.open();
    if (!dir) throw new Error('Missing fixture mount');
    return { dir, root, file, entries };
}
beforeEach(() => vi.resetAllMocks());

describe('WasiDataDir', () => {
    it('releases the data directory descriptor once on disposal', () => {
        const { dir, root } = fixture();
        dir[Symbol.dispose]();
        dir[Symbol.dispose]();
        expect(root.drop).toHaveBeenCalledOnce();
    });

    it('disposes unused mounts, including when no data mount exists', () => {
        const other = { drop: vi.fn() };
        host.directories.mockReturnValue([[other, 'other']]);
        expect(WasiDataDir.open()).toBeUndefined();
        expect(other.drop).toHaveBeenCalledOnce();
        const f = fixture();
        host.directories.mockReturnValue([
            [other, 'other'],
            [f.root, 'data']
        ]);
        expect(WasiDataDir.open()).toBeDefined();
        expect(other.drop).toHaveBeenCalledTimes(2);
        expect(f.root.drop).not.toHaveBeenCalled();
    });

    it('lists the root and frees directory resources on errors', () => {
        const { dir, root, file, entries } = fixture();
        entries.readDirectoryEntry.mockImplementationOnce(() => {
            throw error('io');
        });
        expect(() => dir.list('')).toThrow('io');
        expect(root.openAt).toHaveBeenCalledWith({ symlinkFollow: true }, '.', { directory: true }, { read: true });
        expect(entries.drop).toHaveBeenCalledOnce();
        expect(file.drop).toHaveBeenCalledOnce();
    });

    it('closes descriptors when stat fails or the target is a directory', () => {
        const { dir, file } = fixture();
        file.stat.mockImplementationOnce(() => {
            throw error('io');
        });
        expect(() => dir.open('a')).toThrow('io');
        file.stat.mockReturnValueOnce({ type: 'directory', size: 0n });
        expect(() => dir.open('a')).toThrow('not a regular file');
        expect(file.drop).toHaveBeenCalledTimes(2);
    });

    it('rejects reads after close and invalid ranges before reaching WASI', () => {
        const { dir, file } = fixture();
        const opened = dir.open('a');
        expect(() => opened.read(-1, 3)).toThrow(RangeError);
        expect(() => opened.read(0, 0.5)).toThrow(RangeError);
        expect(file.read).not.toHaveBeenCalled();
        opened.close();
        opened.close();
        expect(() => opened.read(0, 3)).toThrow('closed');
        expect(file.drop).toHaveBeenCalledOnce();
    });

    it('reads partial chunks until EOF and always closes the file', () => {
        const { dir, file } = fixture();
        file.read
            .mockReturnValueOnce([new Uint8Array([1]), false])
            .mockReturnValueOnce([new Uint8Array([2]), false])
            .mockReturnValueOnce([new Uint8Array(), true]);
        expect(dir.readFile('a')).toEqual(new Uint8Array([1, 2]));
        expect(file.drop).toHaveBeenCalledOnce();
    });

    it('does not accept a file as an existing directory', () => {
        const { dir, root } = fixture();
        root.createDirectoryAt.mockImplementation(() => {
            throw error('exist');
        });
        expect(() => dir.createDirectory('a')).toThrow('exist');
        root.statAt.mockReturnValue({ type: 'directory', size: 0n });
        expect(() => dir.createDirectory('a/b')).not.toThrow();
    });

    it('tolerates removal races but preserves other failures', () => {
        const { dir, root } = fixture();
        root.unlinkFileAt.mockImplementationOnce(() => {
            throw error('no-entry');
        });
        expect(() => dir.remove('a')).not.toThrow();
        root.unlinkFileAt.mockImplementationOnce(() => {
            throw error('access');
        });
        expect(() => dir.remove('a')).toThrow('access');
    });

    it('does not clobber existing temporary files and handles short writes', () => {
        const { dir, root, file } = fixture();
        root.openAt.mockImplementationOnce(() => {
            throw error('exist');
        });
        file.write.mockReturnValueOnce(1n).mockReturnValueOnce(2n);
        dir.writeFile('config.toml', new Uint8Array([1, 2, 3]));
        const [first, second] = root.openAt.mock.calls;
        expect(first[1]).not.toBe(second[1]);
        expect(second[2]).toEqual({ create: true, exclusive: true });
        expect(file.write.mock.calls.map(([bytes, offset]) => [[...bytes], offset])).toEqual([
            [[1, 2, 3], 0n],
            [[2, 3], 1n]
        ]);
        expect(file.drop).toHaveBeenCalledOnce();
        expect(root.renameAt).toHaveBeenCalledWith(second[1], root, 'config.toml');
        expect(root.unlinkFileAt).not.toHaveBeenCalled();
    });

    it.each(['write', 'rename'])(
        'cleans up temporary files after a %s failure and preserves the original error',
        (stage) => {
            const { dir, root, file } = fixture();
            if (stage === 'write')
                file.write.mockImplementation(() => {
                    throw error('write failed');
                });
            else
                root.renameAt.mockImplementation(() => {
                    throw error('rename failed');
                });
            root.unlinkFileAt.mockImplementation(() => {
                throw error('cleanup failed');
            });
            expect(() => dir.writeFile('a', new Uint8Array([1]))).toThrow(`${stage} failed`);
            expect(file.drop).toHaveBeenCalledOnce();
            expect(root.unlinkFileAt).toHaveBeenCalledWith(root.openAt.mock.calls[0][1]);
        }
    );

    it('cleans up a write that makes no progress', () => {
        const { dir, root, file } = fixture();
        file.write.mockReturnValue(0n);
        expect(() => dir.writeFile('a', new Uint8Array([1]))).toThrow('could not write a');
        expect(root.renameAt).not.toHaveBeenCalled();
        expect(root.unlinkFileAt).toHaveBeenCalledOnce();
        expect(file.drop).toHaveBeenCalledOnce();
    });
    it('removes symlinks without following their targets', () => {
        const { dir, root } = fixture();
        root.statAt.mockReturnValue({ type: 'symbolic-link', size: 0n });
        dir.remove('link');
        expect(root.statAt).toHaveBeenCalledWith({}, 'link');
        expect(root.unlinkFileAt).toHaveBeenCalledWith('link');
        expect(root.removeDirectoryAt).not.toHaveBeenCalled();
    });

    it('rejects absolute directory paths instead of silently creating a relative directory', () => {
        const { dir, root } = fixture();
        expect(() => dir.createDirectory('/a')).toThrow('must be relative');
        expect(root.createDirectoryAt).not.toHaveBeenCalled();
    });
    it('preserves a write failure when closing also fails', () => {
        const { dir, root, file } = fixture();
        file.write.mockImplementation(() => {
            throw error('write failed');
        });
        file.drop.mockImplementation(() => {
            throw error('close failed');
        });
        expect(() => dir.writeFile('a', new Uint8Array([1]))).toThrow('write failed');
        expect(root.unlinkFileAt).toHaveBeenCalledOnce();
    });
});
