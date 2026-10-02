import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { baseConfig, prepareServerDir } from './server-dir.ts';

const made: string[] = [];
afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('prepareServerDir', () => {
    it('writes a config with free loopback ports, copies plugins and seeds files', async () => {
        const wasm = path.join(await fs.promises.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'x-')), 'p.wasm');
        fs.writeFileSync(wasm, 'wasm');
        made.push(path.dirname(wasm));

        const server = await prepareServerDir({
            plugins: [wasm],
            files: { 'plugins/data/P/config.toml': 'a = 1', 'deep/er/file.bin': new Uint8Array([1, 2, 3]) },
            config: { plugins: { hot_reload: true }, extra: { x: 1 } }
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

    it('gives every server its own directory and ports', async () => {
        const a = await prepareServerDir();
        const b = await prepareServerDir();
        made.push(a.dir, b.dir);
        expect(a.dir).not.toBe(b.dir);
        expect(new Set([a.javaPort, a.bedrockPort, b.javaPort, b.bedrockPort]).size).toBe(4);
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
