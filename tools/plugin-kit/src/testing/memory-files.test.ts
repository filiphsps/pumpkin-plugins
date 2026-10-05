import { describe, expect, it } from 'vitest';
import { MemoryFiles } from './memory-files.ts';

describe('MemoryFiles', () => {
    it('copies written and read bytes so callers cannot mutate stored content', () => {
        const files = new MemoryFiles();
        const bytes = new Uint8Array([1, 2, 3]);
        files.put('a', bytes);
        bytes[0] = 9;
        files.readFile('a')[0] = 8;
        const opened = files.open('a');
        opened.read(0, 3)[0] = 7;
        expect(files.readFile('a')).toEqual(new Uint8Array([1, 2, 3]));
        files.writeFile('b', bytes);
        bytes[0] = 6;
        expect(files.readFile('b')[0]).toBe(9);
    });

    it('requires existing parents for writes while put remains a fixture builder', () => {
        const files = new MemoryFiles();
        expect(() => files.writeFile('missing/a', new Uint8Array())).toThrow('no-entry');
        files.put('missing/a', 'fixture');
        files.writeFile('missing/b', new Uint8Array([1]));
        expect(files.list('missing').sort()).toEqual(['a', 'b']);
    });

    it('does not remove nonempty directories', () => {
        const files = new MemoryFiles().put('folder/a', 'a');
        expect(() => files.remove('folder')).toThrow('not-empty');
        expect(files.text('folder/a')).toBe('a');
        files.remove('folder/a');
        files.remove('folder');
        expect(files.stat('folder')).toBeUndefined();
        expect(() => files.remove('missing')).not.toThrow();
    });

    it('does not replace directories with files or use files as directories', () => {
        const files = new MemoryFiles().put('a', 'file');
        expect(() => files.createDirectory('a/b')).toThrow('not-directory');
        expect(() => files.put('a/b', 'bad')).toThrow('not-directory');
        expect(files.stat('a/b')).toBeUndefined();
        files.createDirectory('folder');
        expect(() => files.put('folder', 'bad')).toThrow('is-directory');
        expect(files.stat('folder')?.kind).toBe('directory');
    });

    it('keeps an opened snapshot after atomic replacement and enforces close', () => {
        const files = new MemoryFiles().put('a', 'old');
        const opened = files.open('a');
        files.put('a', 'new');
        expect(new TextDecoder().decode(opened.read(0, 3))).toBe('old');
        expect(() => opened.read(-1, 3)).toThrow(RangeError);
        opened.close();
        opened.close();
        expect(() => opened.read(0, 3)).toThrow('closed');
    });
});
