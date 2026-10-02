import * as fs from 'node:fs';
import * as path from 'node:path';
import { builtPluginPath, freePort, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterEach } from 'vitest';

/** Name the plugin gives Pumpkin, which is also its data folder name. */
export const PLUGIN_NAME = 'BedrockAddonManager';

/** A Pumpkin server running the plugin, with the web server on a known port. */
export interface Running {
    server: PumpkinInstance;
    /** Port the plugin's web server listens on. */
    port: number;
    /** The plugin's data folder on disk. */
    data: string;
    /** URL of a path on the plugin's web server. */
    url(urlPath: string): string;
    /** Writes a file into the data folder while the server runs. */
    put(relative: string, content: Uint8Array | string): void;
    /** Reads a file from the data folder. */
    read(relative: string): string;
    /** Stops the server. */
    stop(): Promise<void>;
}

export interface StartOptions {
    /** Label for saved server logs. */
    name: string;
    /** Config file to seed, given the port to use. Omit to let the plugin create it. */
    config?: (port: number) => string;
    /** Overrides merged into the server's `pumpkin.toml`. */
    pumpkin?: Record<string, unknown>;
    /** Files to seed in the data folder, by relative path. */
    files?: Record<string, Uint8Array | string>;
}

/** Starts a Pumpkin server with the built plugin, seeding its data folder first. */
export async function startPlugin(options: StartOptions): Promise<Running> {
    const port = await freePort();
    const root = `plugins/data/${PLUGIN_NAME}`;
    const files: Record<string, Uint8Array | string> = {};
    if (options.config) files[`${root}/config.toml`] = options.config(port);
    for (const [relative, content] of Object.entries(options.files ?? {})) files[`${root}/${relative}`] = content;

    const server = await startPumpkin({
        name: options.name,
        plugins: [builtPluginPath(process.cwd())],
        files,
        config: options.pumpkin
    });
    const data = server.pluginDataDir(PLUGIN_NAME);
    return {
        server,
        port,
        data,
        url: (urlPath) => `http://127.0.0.1:${port}${urlPath}`,
        put: (relative, content) => {
            const file = path.join(data, relative);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, content);
        },
        read: (relative) => fs.readFileSync(path.join(data, relative), 'utf8'),
        stop: () => server.stop()
    };
}

/** A minimal config that only sets the port and public URL, so the plugin has to fill in the rest. */
export const portConfig = (port: number, extra = '') =>
    `[web]\nport = ${port}\npublic_url = "http://127.0.0.1:${port}"\n${extra}`;

/**
 * Call once at the top of a test file. Returns a `start` function whose servers are all stopped
 * after each test.
 */
export function pluginServers(): (options: StartOptions) => Promise<Running> {
    const running: Running[] = [];
    afterEach(async () => {
        await Promise.all(running.splice(0).map((r) => r.stop()));
    });
    return async (options) => {
        const r = await startPlugin(options);
        running.push(r);
        return r;
    };
}
