import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUMPKIN_RELEASE } from '@pumpkin-plugins/test-harness';
import { PIE_RELEASE } from './release.ts';

export { PIE_RELEASE };

export interface ProviderOptions {
    cacheDir?: string;
    fetch?: typeof globalThis.fetch;
}

/** Resolve the exact release asset, verifying downloaded and cached bytes and the targeted server release. */
export async function resolvePieProvider(options: ProviderOptions = {}): Promise<string> {
    if (PUMPKIN_RELEASE !== PIE_RELEASE.pumpkinRelease)
        throw new Error(
            `PumpkinPIE ${PIE_RELEASE.tag} targets Pumpkin ${PIE_RELEASE.pumpkinRelease}, but the harness pins ${PUMPKIN_RELEASE}`,
        );
    const cacheDir = options.cacheDir ?? fileURLToPath(new URL('../../../../.cache/pumpkin-pie/', import.meta.url));
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
            `PumpkinPIE ${PIE_RELEASE.tag} SHA-256 mismatch: expected ${PIE_RELEASE.sha256}, got ${actual}`,
        );
}
