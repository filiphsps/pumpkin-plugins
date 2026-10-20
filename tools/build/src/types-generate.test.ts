import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs')>();
    return { ...original, renameSync: vi.fn(original.renameSync) };
});

import { BuildError } from './errors.ts';
import { generateTypes } from './types.ts';

const jco = vi.mocked(execFileSync);
const dirs: string[] = [];

beforeEach(() => {
    jco.mockImplementation((_file, args) => {
        const outputIndex = args?.indexOf('-o') ?? -1;
        const output = args?.[outputIndex + 1];
        if (!output) throw new Error('missing jco output argument');
        fs.writeFileSync(path.join(output, 'index.d.ts'), 'export type Size = bigint;');
        fs.writeFileSync(path.join(output, 'stale.d.ts'), 'export type OldBinding = string;');
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

function failRenames(...failures: (Error | undefined)[]): void {
    const rename = vi.mocked(fs.renameSync);
    const actualRename = rename.getMockImplementation();
    if (!actualRename) throw new Error('missing real rename implementation');
    for (const failure of failures) {
        rename.mockImplementationOnce((source, destination) => {
            if (failure) throw failure;
            actualRename(source, destination);
        });
    }
}

describe('generateTypes', () => {
    it('runs jco through Node for Windows compatibility', () => {
        const { output } = outputAt();

        generateTypes('wit', output);

        const [executable, args] = jco.mock.calls[0] ?? [];
        expect(executable).toBe(process.execPath);
        expect(args).toContain('guest-types');
        expect(args).toContain('wit');
        expect(fs.existsSync(path.join(output, 'index.d.ts'))).toBe(true);
    });

    it('replaces stale generated files', () => {
        const { output } = outputAt();
        generateTypes('wit', output);
        expect(fs.readdirSync(output).sort()).toEqual(['index.d.ts', 'stale.d.ts']);

        jco.mockImplementation((_file, args) => {
            const outputIndex = args?.indexOf('-o') ?? -1;
            const generated = args?.[outputIndex + 1];
            if (!generated) throw new Error('missing jco output argument');
            fs.writeFileSync(path.join(generated, 'index.d.ts'), 'export type Size = number;');
            return Buffer.alloc(0);
        });
        generateTypes('updated-wit', output);

        expect(fs.readdirSync(output)).toEqual(['index.d.ts']);
        expect(fs.readFileSync(path.join(output, 'index.d.ts'), 'utf8')).toBe('export type Size = number;');
        expect(fs.readdirSync(path.dirname(output))).toEqual(['bindings']);
    });

    it('preserves the previous declarations and cleans staging files when jco fails', () => {
        const { output } = outputAt();
        generateTypes('wit', output);
        jco.mockImplementation(() => {
            throw new Error('jco failed');
        });

        expect(() => generateTypes('broken-wit', output)).toThrow(BuildError);
        expect(fs.readdirSync(output).sort()).toEqual(['index.d.ts', 'stale.d.ts']);
        expect(fs.readdirSync(path.dirname(output))).toEqual(['bindings']);
    });

    it('restores existing declarations if publishing generated types fails', () => {
        const { dir, output } = outputAt();
        fs.mkdirSync(output);
        fs.writeFileSync(path.join(output, 'index.d.ts'), 'export type Size = number;');
        failRenames(undefined, new Error('type publish failed'));

        expect(() => generateTypes('wit', output)).toThrow('type publish failed');

        expect(fs.readFileSync(path.join(output, 'index.d.ts'), 'utf8')).toBe('export type Size = number;');
        expect(fs.readdirSync(dir)).toEqual(['bindings']);
    });

    it('preserves a recovery copy if publishing and restoring declarations both fail', () => {
        const { output } = outputAt();
        fs.mkdirSync(output);
        fs.writeFileSync(path.join(output, 'index.d.ts'), 'export type Size = number;');
        failRenames(undefined, new Error('type publish failed'), new Error('restore failed'));

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
