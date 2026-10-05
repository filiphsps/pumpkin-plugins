import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('esbuild', () => ({ build: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs')>();
    return { ...original, renameSync: vi.fn(original.renameSync) };
});

import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { bundlePlugin } from './bundle.ts';

const dirs: string[] = [];
const componentize = vi.mocked(execFileSync);
const esbuild = vi.mocked(build);

beforeEach(() => {
    esbuild.mockResolvedValue({} as never);
    componentize.mockImplementation((_file, args) => {
        const outputIndex = args?.indexOf('--output') ?? -1;
        const output = args?.[outputIndex + 1];
        if (!output) throw new Error('missing componentizer output argument');
        fs.writeFileSync(output, 'component');
        return Buffer.alloc(0);
    });
});

afterEach(() => {
    vi.clearAllMocks();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function buildAt(name = 'plugin.wasm'): { dir: string; output: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-build-'));
    dirs.push(dir);
    return { dir, output: path.join(dir, name) };
}

describe('bundlePlugin', () => {
    it('publishes a completed component and returns its size', async () => {
        const { output } = buildAt();
        fs.writeFileSync(output, 'old artifact');

        const size = await bundlePlugin({ entry: 'src/plugin.ts', output, witDir: 'wit', version: '1.0.0' });

        expect(size).toBe(Buffer.byteLength('component'));
        expect(fs.readFileSync(output, 'utf8')).toBe('component');
        expect(fs.readdirSync(path.dirname(output))).toEqual(['plugin.wasm']);
    });

    it('keeps the previous artifact and removes staging files when componentization fails', async () => {
        const { output } = buildAt();
        fs.writeFileSync(output, 'known-good artifact');
        componentize.mockImplementation((_file, args) => {
            const outputIndex = args?.indexOf('--output') ?? -1;
            const staged = args?.[outputIndex + 1];
            if (!staged) throw new Error('missing componentizer output argument');
            fs.writeFileSync(staged, 'partial component');
            throw new Error('componentizer failed');
        });

        await expect(bundlePlugin({ entry: 'src/plugin.ts', output, witDir: 'wit', version: '1.0.0' })).rejects.toThrow(
            'componentizer failed'
        );

        expect(fs.readFileSync(output, 'utf8')).toBe('known-good artifact');
        expect(fs.readdirSync(path.dirname(output))).toEqual(['plugin.wasm']);
    });

    it('replaces an existing artifact when rename cannot overwrite it directly', async () => {
        const { output } = buildAt();
        fs.writeFileSync(output, 'old artifact');
        const rename = vi.mocked(fs.renameSync).mockImplementationOnce(() => {
            throw Object.assign(new Error('access denied'), { code: 'EACCES' });
        });

        const size = await bundlePlugin({ entry: 'src/plugin.ts', output, witDir: 'wit', version: '1.0.0' });

        expect(size).toBe(Buffer.byteLength('component'));
        expect(fs.readFileSync(output, 'utf8')).toBe('component');
        expect(fs.readdirSync(path.dirname(output))).toEqual(['plugin.wasm']);
        expect(rename).toHaveBeenCalledTimes(3);
    });

    it('restores the previous artifact if publishing fails after it was moved aside', async () => {
        const { output } = buildAt();
        fs.writeFileSync(output, 'known-good artifact');
        const rename = vi.mocked(fs.renameSync);
        const actualRename = rename.getMockImplementation();
        if (!actualRename) throw new Error('missing real rename implementation');
        rename
            .mockImplementationOnce(() => {
                throw Object.assign(new Error('access denied'), { code: 'EACCES' });
            })
            .mockImplementationOnce((source, destination) => actualRename(source, destination))
            .mockImplementationOnce(() => {
                throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            })
            .mockImplementationOnce((source, destination) => actualRename(source, destination));

        await expect(bundlePlugin({ entry: 'src/plugin.ts', output, witDir: 'wit', version: '1.0.0' })).rejects.toThrow(
            'disk full'
        );

        expect(fs.readFileSync(output, 'utf8')).toBe('known-good artifact');
        expect(fs.readdirSync(path.dirname(output))).toEqual(['plugin.wasm']);
        expect(rename).toHaveBeenCalledTimes(4);
    });

    it('preserves a recovery copy if publishing and restoring both fail', async () => {
        const { output } = buildAt();
        fs.writeFileSync(output, 'known-good artifact');
        const rename = vi.mocked(fs.renameSync);
        const actualRename = rename.getMockImplementation();
        if (!actualRename) throw new Error('missing real rename implementation');
        rename
            .mockImplementationOnce(() => {
                throw Object.assign(new Error('access denied'), { code: 'EACCES' });
            })
            .mockImplementationOnce((source, destination) => actualRename(source, destination))
            .mockImplementationOnce(() => {
                throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            })
            .mockImplementationOnce(() => {
                throw Object.assign(new Error('read only filesystem'), { code: 'EROFS' });
            });

        const failure: unknown = await bundlePlugin({
            entry: 'src/plugin.ts',
            output,
            witDir: 'wit',
            version: '1.0.0'
        }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AggregateError);
        const message = (failure as AggregateError).message;
        const recoveryPath = message.split('previous artifact preserved at ')[1];
        expect(recoveryPath).toBeDefined();
        expect(fs.readFileSync(recoveryPath ?? '', 'utf8')).toBe('known-good artifact');
    });

    it('uses separate temporary bundles for concurrent builds', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-build-'));
        dirs.push(dir);
        const first = { output: path.join(dir, 'first.wasm') };
        const second = { output: path.join(dir, 'second.wasm') };
        const bundles: string[] = [];
        esbuild.mockImplementation(async ({ outfile }) => {
            bundles.push(outfile as string);
            await Promise.resolve();
            fs.writeFileSync(outfile as string, 'bundle');
            return {} as never;
        });

        await Promise.all([
            bundlePlugin({ entry: 'src/first.ts', output: first.output, witDir: 'wit', version: '1.0.0' }),
            bundlePlugin({ entry: 'src/second.ts', output: second.output, witDir: 'wit', version: '1.0.0' })
        ]);

        expect(new Set(bundles).size).toBe(2);
        expect(fs.readFileSync(first.output, 'utf8')).toBe('component');
        expect(fs.readFileSync(second.output, 'utf8')).toBe('component');
    });
});
