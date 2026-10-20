import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { baseConfig, prepareServerDir } from './server-dir.ts';

const made: string[] = [];
afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function expectRejectedPath(relativePath: string): Promise<void> {
    const result = prepareServerDir({ files: { [relativePath]: 'content' } }).then((server) => {
        made.push(server.dir);
        throw new Error('Server directory unexpectedly accepted an escaping file path.');
    });
    await expect(result).rejects.toThrow(/must be relative to and remain inside the server directory/);
}

describe('prepareServerDir', () => {
    it('writes a config with free loopback ports, copies plugins and seeds files', async () => {
        const wasm = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'x-')), 'p.wasm');
        fs.writeFileSync(wasm, 'wasm');
        made.push(path.dirname(wasm));

        const server = await prepareServerDir({
            plugins: [wasm],
            files: { 'plugins/data/P/config.toml': 'a = 1', 'deep/er/file.bin': new Uint8Array([1, 2, 3]) },
            config: { plugins: { hot_reload: true }, extra: { x: 1 } },
        });
        made.push(server.dir);

        expect(server.javaPort).not.toBe(server.bedrockPort);
        expect(fs.readFileSync(path.join(server.dir, 'plugins/p.wasm'), 'utf8')).toBe('wasm');
        expect(fs.readFileSync(path.join(server.dir, 'plugins/data/P/config.toml'), 'utf8')).toBe('a = 1');
        expect([...fs.readFileSync(path.join(server.dir, 'deep/er/file.bin'))]).toEqual([1, 2, 3]);

        const config = parse(fs.readFileSync(path.join(server.dir, 'pumpkin.toml'), 'utf8')) as {
            networking: { java: { address: string }; bedrock: { nethernet: { address: string } } };
            plugins: Record<string, unknown>;
            extra: Record<string, unknown>;
        };
        expect(config.networking.java.address).toBe(`127.0.0.1:${server.javaPort}`);
        expect(config.networking.bedrock.nethernet.address).toBe(`127.0.0.1:${server.bedrockPort}`);
        expect(config.plugins).toEqual({ ask_permission_confirmation: false, hot_reload: true });
        expect(config.extra).toEqual({ x: 1 });
    });

    it.each([
        ['the same destination basename', 'shared.wasm', 'shared.wasm'],
        ['basenames that differ only by case', 'shared.wasm', 'Shared.wasm'],
    ])('rejects plugins with %s', async (_description, firstName, secondName) => {
        const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-plugin-sources-'));
        made.push(sourceDir);
        const firstPlugin = path.join(sourceDir, 'first', firstName);
        const secondPlugin = path.join(sourceDir, 'second', secondName);
        fs.mkdirSync(path.dirname(firstPlugin));
        fs.mkdirSync(path.dirname(secondPlugin));
        fs.writeFileSync(firstPlugin, 'first');
        fs.writeFileSync(secondPlugin, 'second');

        const outcome = await prepareServerDir({ plugins: [firstPlugin, secondPlugin] }).then(
            (server) => {
                made.push(server.dir);
                return server.dir;
            },
            (error: unknown) => error,
        );

        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).message).toMatch(/(?:duplicate|collid).*shared\.wasm/i);
    });

    it('gives every server its own directory and ports', async () => {
        const a = await prepareServerDir();
        const b = await prepareServerDir();
        made.push(a.dir, b.dir);
        expect(a.dir).not.toBe(b.dir);
        expect(new Set([a.javaPort, a.bedrockPort, b.javaPort, b.bedrockPort]).size).toBe(4);
    });

    it('removes the temporary directory when setup fails', async () => {
        const missingPlugin = path.join(os.tmpdir(), `pumpkin-missing-${randomUUID()}.wasm`);
        const failure = await prepareServerDir({ plugins: [missingPlugin] }).then(
            (server) => {
                made.push(server.dir);
                throw new Error('Expected plugin copy to fail.');
            },
            (error: unknown) => error,
        );

        expect(failure).toMatchObject({ code: 'ENOENT', syscall: 'copyfile' });
        const destination = (failure as { dest?: unknown }).dest;
        if (typeof destination !== 'string') {
            throw new Error(`Expected copy failure to include its destination, received ${String(failure)}`);
        }
        const serverDir = path.dirname(path.dirname(destination));
        made.push(serverDir);
        expect(fs.existsSync(serverDir)).toBe(false);
    });

    it('rejects a seeded path that escapes the server directory without changing the outside file', async () => {
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-test-outside-'));
        made.push(outsideDir);
        const outsideFile = path.join(outsideDir, 'outside.txt');
        fs.writeFileSync(outsideFile, 'original');

        // Server directories are created directly in the temp directory, like this sibling.
        const serverDir = path.join(os.tmpdir(), 'pumpkin-test-sibling');
        const relativePath = path.relative(serverDir, outsideFile);
        const nestedRelativePath = ['nested', path.relative(path.join(serverDir, 'nested'), outsideFile)].join(
            path.sep,
        );
        const windowsRelativePath = relativePath.split(path.sep).join(path.win32.sep);
        const nestedWindowsRelativePath = nestedRelativePath.split(path.sep).join(path.win32.sep);

        for (const filePath of new Set([
            relativePath,
            nestedRelativePath,
            windowsRelativePath,
            nestedWindowsRelativePath,
            outsideFile,
        ])) {
            await expectRejectedPath(filePath);
        }
        expect(fs.readFileSync(outsideFile, 'utf8')).toBe('original');
    });
});

describe('baseConfig', () => {
    it('turns off everything that would prompt, broadcast or phone home', () => {
        const config = baseConfig(1, 2) as Record<string, Record<string, unknown>>;
        expect(config.telemetry).toEqual({ enabled: false });
        expect(config.plugins).toMatchObject({ ask_permission_confirmation: false, hot_reload: false });
        expect(config.commands).toEqual({ use_tty: false });
    });
});
