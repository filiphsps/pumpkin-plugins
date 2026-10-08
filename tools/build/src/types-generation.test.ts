import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateTypes } from './types.ts';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs')>();
    return { ...original, renameSync: vi.fn(original.renameSync) };
});

const dirs: string[] = [];
const componentize = vi.mocked(execFileSync);

beforeEach(() => {
    componentize.mockImplementation((_file, args) => {
        const output = args?.[args.indexOf('-o') + 1];
        if (!output) throw new Error('missing generated types directory');
        fs.writeFileSync(path.join(output, 'index.d.ts'), 'export type Size = bigint;');
        return Buffer.alloc(0);
    });
});

afterEach(() => {
    vi.clearAllMocks();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function outputAt(): { dir: string; output: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-types-'));
    dirs.push(dir);
    return { dir, output: path.join(dir, 'bindings') };
}

describe('generateTypes', () => {
    it('preserves bigint guest declarations and publishes them at the requested path', () => {
        const { dir, output } = outputAt();

        generateTypes('wit', output);

        expect(fs.readFileSync(path.join(output, 'index.d.ts'), 'utf8')).toBe('export type Size = bigint;');
        expect(fs.readdirSync(dir)).toEqual(['bindings']);
        expect(componentize).toHaveBeenCalledOnce();
    });

    it('keeps existing declarations and removes staging files if jco fails', () => {
        const { dir, output } = outputAt();
        fs.mkdirSync(output);
        fs.writeFileSync(path.join(output, 'index.d.ts'), 'export type Size = number;');
        componentize.mockImplementation(() => {
            throw new Error('jco failed');
        });

        expect(() => generateTypes('wit', output)).toThrow('jco failed');

        expect(fs.readFileSync(path.join(output, 'index.d.ts'), 'utf8')).toBe('export type Size = number;');
        expect(fs.readdirSync(dir)).toEqual(['bindings']);
    });

    it('restores existing declarations if publishing generated types fails', () => {
        const { dir, output } = outputAt();
        fs.mkdirSync(output);
        fs.writeFileSync(path.join(output, 'index.d.ts'), 'export type Size = number;');
        const rename = vi.mocked(fs.renameSync);
        const actualRename = rename.getMockImplementation();
        if (!actualRename) throw new Error('missing real rename implementation');
        rename
            .mockImplementationOnce((source, destination) => actualRename(source, destination))
            .mockImplementationOnce(() => {
                throw new Error('type publish failed');
            })
            .mockImplementationOnce((source, destination) => actualRename(source, destination));

        expect(() => generateTypes('wit', output)).toThrow('type publish failed');

        expect(fs.readFileSync(path.join(output, 'index.d.ts'), 'utf8')).toBe('export type Size = number;');
        expect(fs.readdirSync(dir)).toEqual(['bindings']);
        expect(rename).toHaveBeenCalledTimes(3);
    });

    it('preserves a recovery copy if publishing and restoring declarations both fail', () => {
        const { output } = outputAt();
        fs.mkdirSync(output);
        fs.writeFileSync(path.join(output, 'index.d.ts'), 'export type Size = number;');
        const rename = vi.mocked(fs.renameSync);
        const actualRename = rename.getMockImplementation();
        if (!actualRename) throw new Error('missing real rename implementation');
        rename
            .mockImplementationOnce((source, destination) => actualRename(source, destination))
            .mockImplementationOnce(() => {
                throw new Error('type publish failed');
            })
            .mockImplementationOnce(() => {
                throw new Error('restore failed');
            });

        let failure: unknown;
        try {
            generateTypes('wit', output);
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(AggregateError);
        const message = (failure as AggregateError).message;
        const recoveryPath = message.split('previous declarations preserved at ')[1];
        expect(recoveryPath).toBeDefined();
        expect(fs.readFileSync(path.join(recoveryPath ?? '', 'index.d.ts'), 'utf8')).toBe('export type Size = number;');
    });
});
