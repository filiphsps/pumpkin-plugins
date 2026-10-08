import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

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

function outputAt(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-types-'));
    dirs.push(dir);
    return path.join(dir, 'bindings');
}

describe('generateTypes', () => {
    it('replaces stale generated files and preserves bigint declarations', () => {
        const output = outputAt();
        generateTypes('wit', output);
        expect(fs.readdirSync(output).sort()).toEqual(['index.d.ts', 'stale.d.ts']);

        jco.mockImplementation((_file, args) => {
            const outputIndex = args?.indexOf('-o') ?? -1;
            const generated = args?.[outputIndex + 1];
            if (!generated) throw new Error('missing jco output argument');
            fs.writeFileSync(path.join(generated, 'index.d.ts'), 'export type Size = bigint;');
            return Buffer.alloc(0);
        });
        generateTypes('updated-wit', output);

        expect(fs.readdirSync(output)).toEqual(['index.d.ts']);
        expect(fs.readFileSync(path.join(output, 'index.d.ts'), 'utf8')).toBe('export type Size = bigint;');
        expect(fs.readdirSync(path.dirname(output))).toEqual(['bindings']);
    });

    it('preserves the previous declarations and cleans staging files when jco fails', () => {
        const output = outputAt();
        generateTypes('wit', output);
        jco.mockImplementation(() => {
            throw new Error('jco failed');
        });

        expect(() => generateTypes('broken-wit', output)).toThrow('jco failed');
        expect(fs.readdirSync(output).sort()).toEqual(['index.d.ts', 'stale.d.ts']);
        expect(fs.readdirSync(path.dirname(output))).toEqual(['bindings']);
    });
});
