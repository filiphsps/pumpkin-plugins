import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stringify } from 'smol-toml';
import { freePort } from './ports.ts';
import { deepMerge } from './util.ts';

/** What goes into a test server's directory. */
export interface ServerDirOptions {
    /** Paths to built plugin `.wasm` files, copied into the server's `plugins/` folder. */
    plugins?: string[];
    /** Overrides merged into the generated `pumpkin.toml` (Pumpkin fills in the rest). */
    config?: Record<string, unknown>;
    /** Files to create before startup, keyed by path relative to the server directory. */
    files?: Record<string, string | Uint8Array>;
}

/** A server directory ready to start from, and the ports its config listens on. */
export interface ServerDir {
    /** The temporary directory the server runs in. */
    dir: string;
    /** Port of the Java edition listener. */
    javaPort: number;
    /** Port of the Bedrock edition listener. */
    bedrockPort: number;
}

/**
 * The `pumpkin.toml` overrides every test server gets: free ports on loopback, no LAN broadcast,
 * telemetry or terminal UI, and no prompting for plugin permissions.
 * @param javaPort - Port for the Java edition.
 * @param bedrockPort - Port for the Bedrock edition.
 * @returns A partial config; Pumpkin fills in the rest.
 */
export function baseConfig(javaPort: number, bedrockPort: number): Record<string, unknown> {
    return {
        networking: {
            java: { address: `127.0.0.1:${javaPort}` },
            bedrock: { nethernet: { address: `127.0.0.1:${bedrockPort}` } },
            lan_broadcast: { enabled: false }
        },
        telemetry: { enabled: false },
        plugins: { ask_permission_confirmation: false, hot_reload: false },
        commands: { use_tty: false },
        logging: { color: false }
    };
}

/**
 * Creates a temporary directory with a `pumpkin.toml`, the plugins and any seeded files.
 * @param options - What to put in it.
 * @returns The directory and the ports chosen.
 */
export async function prepareServerDir(options: ServerDirOptions = {}): Promise<ServerDir> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-test-'));
    const javaPort = await freePort();
    const bedrockPort = await freePort();

    fs.mkdirSync(path.join(dir, 'plugins'));
    for (const plugin of options.plugins ?? []) {
        fs.copyFileSync(plugin, path.join(dir, 'plugins', path.basename(plugin)));
    }
    for (const [relative, content] of Object.entries(options.files ?? {})) {
        const file = path.join(dir, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    const config = deepMerge(baseConfig(javaPort, bedrockPort), options.config ?? {});
    fs.writeFileSync(path.join(dir, 'pumpkin.toml'), stringify(config));
    return { dir, javaPort, bedrockPort };
}
