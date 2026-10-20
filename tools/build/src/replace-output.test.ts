import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs')>();
    return { ...original, renameSync: vi.fn(original.renameSync) };
});

import { replaceOutput } from './replace-output.ts';

const rename = vi.mocked(fs.renameSync);
const realRename = rename.getMockImplementation();
if (!realRename) throw new Error('missing real rename implementation');
let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replace-output-'));
});

afterEach(() => {
    rename.mockReset();
    rename.mockImplementation(realRename);
    fs.rmSync(dir, { recursive: true, force: true });
});

function fail(code: string): () => never {
    return () => {
        throw Object.assign(new Error(code), { code });
    };
}

describe('replaceOutput', () => {
    it('changes nothing when the target is missing', () => {
        const staged = path.join(dir, 'staged.wasm');
        const target = path.join(dir, 'plugin.wasm');
        const aside = path.join(dir, 'previous.wasm');
        fs.writeFileSync(staged, 'new');
        const onRestoreFailure = vi.fn();

        expect(() => replaceOutput(staged, target, aside, 'unused', onRestoreFailure)).toThrow(
            expect.objectContaining({ code: 'ENOENT' }),
        );

        expect(fs.readdirSync(dir)).toEqual(['staged.wasm']);
        expect(fs.readFileSync(staged, 'utf8')).toBe('new');
        expect(onRestoreFailure).not.toHaveBeenCalled();
    });

    it('moves the old output back and rethrows when the staged output cannot take its place', () => {
        const staged = path.join(dir, 'staged.wasm');
        const target = path.join(dir, 'plugin.wasm');
        const aside = path.join(dir, 'previous.wasm');
        fs.writeFileSync(staged, 'new');
        fs.writeFileSync(target, 'old');
        const publishError = Object.assign(new Error('access denied'), { code: 'EACCES' });
        rename.mockImplementationOnce(realRename).mockImplementationOnce(() => {
            throw publishError;
        });
        const onRestoreFailure = vi.fn();

        expect(() => replaceOutput(staged, target, aside, 'unused', onRestoreFailure)).toThrow(publishError);

        expect(fs.readFileSync(target, 'utf8')).toBe('old');
        expect(fs.readFileSync(staged, 'utf8')).toBe('new');
        expect(fs.existsSync(aside)).toBe(false);
        expect(onRestoreFailure).not.toHaveBeenCalled();
    });

    it('keeps the old output aside and reports both errors when it cannot be moved back', () => {
        const staged = path.join(dir, 'staged.wasm');
        const target = path.join(dir, 'plugin.wasm');
        const aside = path.join(dir, 'previous.wasm');
        fs.writeFileSync(staged, 'new');
        fs.writeFileSync(target, 'old');
        rename
            .mockImplementationOnce(realRename)
            .mockImplementationOnce(fail('ENOSPC'))
            .mockImplementationOnce(fail('EROFS'));
        const onRestoreFailure = vi.fn();

        let failure: unknown;
        try {
            replaceOutput(staged, target, aside, `old output kept at ${aside}`, onRestoreFailure);
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).message).toBe(`old output kept at ${aside}`);
        expect((failure as AggregateError).errors.map((error: NodeJS.ErrnoException) => error.code)).toEqual([
            'ENOSPC',
            'EROFS',
        ]);
        expect(onRestoreFailure).toHaveBeenCalledOnce();
        expect(fs.readFileSync(aside, 'utf8')).toBe('old');
        expect(fs.existsSync(target)).toBe(false);
    });

    it('restores a directory target with its contents when the staged output cannot take its place', () => {
        const staged = path.join(dir, 'staged');
        const target = path.join(dir, 'types');
        const aside = path.join(dir, 'previous');
        fs.mkdirSync(staged);
        fs.writeFileSync(path.join(staged, 'index.d.ts'), 'new');
        fs.mkdirSync(path.join(target, 'interfaces'), { recursive: true });
        fs.writeFileSync(path.join(target, 'interfaces', 'plugin.d.ts'), 'old');
        rename.mockImplementationOnce(realRename).mockImplementationOnce(fail('EBUSY'));

        expect(() => replaceOutput(staged, target, aside, 'unused')).toThrow('EBUSY');

        expect(fs.readFileSync(path.join(target, 'interfaces', 'plugin.d.ts'), 'utf8')).toBe('old');
        expect(fs.readdirSync(dir).sort()).toEqual(['staged', 'types']);
    });
});
