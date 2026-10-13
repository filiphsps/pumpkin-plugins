import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** External GPL provider fixture; never part of the API's production exports. */
export const PIE_RELEASE = {
    tag: 'v0.2.3',
    sourceCommit: 'b7cbb14417b397bca71a36b62efa8caa1ba72354',
    sha256: '04c23e0ce814a461eb07efc3641457b893ad4519a073d6bad3dc5799b4d1e61f',
    asset: 'pumpkin_pie_plugin.wasm',
    license: 'GPL-3.0-only',
    pumpkinRelease: '0.2.0+26.3-26.51',
    pumpkinCommit: '204a94ed895f041a845630d5a23c094705a0704e',
    apiArtifact: 'v0.1.1'
} as const;

export interface ProviderOptions {
    cacheDir?: string;
    fetch?: typeof globalThis.fetch;
}

/** Resolve the exact release asset, verifying downloaded and cached bytes. */
export async function resolvePieProvider(options: ProviderOptions = {}): Promise<string> {
    const cacheDir = options.cacheDir ?? fileURLToPath(new URL('../../../.cache/pumpkin-pie/', import.meta.url));
    const target = path.join(cacheDir, `${PIE_RELEASE.tag}-${PIE_RELEASE.asset}`);
    let cached: Uint8Array | undefined;
    try {
        cached = await fs.readFile(target);
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (cached) {
        verify(cached);
        return target;
    }

    const url = `https://github.com/Rennex07/PumpkinPIE/releases/download/${PIE_RELEASE.tag}/${PIE_RELEASE.asset}`;
    const response = await (options.fetch ?? globalThis.fetch)(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Downloading PumpkinPIE ${PIE_RELEASE.tag} failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    verify(bytes);
    await fs.mkdir(cacheDir, { recursive: true });
    const partial = `${target}.${randomUUID()}.partial`;
    try {
        await fs.writeFile(partial, bytes, { flag: 'wx' });
        await fs.rename(partial, target);
    } finally {
        await fs.rm(partial, { force: true });
    }
    return target;
}

function verify(bytes: Uint8Array): void {
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== PIE_RELEASE.sha256)
        throw new Error(
            `PumpkinPIE ${PIE_RELEASE.tag} SHA-256 mismatch: expected ${PIE_RELEASE.sha256}, got ${actual}`
        );
}
