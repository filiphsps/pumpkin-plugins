import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PUMPKIN_RELEASE, PUMPKIN_RELEASE_SHA256 } from './pumpkin-version.ts';
import { REPO_ROOT } from './repo-root.ts';
import { assetName, isMuslLinux } from './util.ts';

function downloadUrl(file: string): string {
    return `https://github.com/Pumpkin-MC/Pumpkin/releases/download/${encodeURIComponent(PUMPKIN_RELEASE)}/${file}`;
}

function verifyChecksum(asset: string, bytes: Buffer, expected: string): void {
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) {
        throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
    }
}

/**
 * Returns `PUMPKIN_BIN` when set; otherwise returns the pinned release binary from
 * `PUMPKIN_CACHE_DIR` (default `<repo>/.cache/pumpkin`), checking downloads and cached files
 * against the SHA-256 pinned in `pumpkin-version.ts`. A verified cached binary needs no network.
 */
export async function resolvePumpkinBinary(): Promise<string> {
    const override = process.env.PUMPKIN_BIN;
    if (override) {
        if (!fs.existsSync(override)) throw new Error(`PUMPKIN_BIN does not exist: ${override}`);
        return path.resolve(override);
    }

    const asset = assetName(process.platform, process.arch, isMuslLinux());
    const cacheDir = process.env.PUMPKIN_CACHE_DIR ?? path.join(REPO_ROOT, '.cache/pumpkin');
    const target = path.join(cacheDir, `${PUMPKIN_RELEASE}-${asset}`);
    const expected = PUMPKIN_RELEASE_SHA256[asset];
    if (!expected) throw new Error(`No pinned SHA-256 for ${asset} of Pumpkin ${PUMPKIN_RELEASE}`);

    if (fs.existsSync(target)) {
        verifyChecksum(asset, fs.readFileSync(target), expected);
        return target;
    }

    fs.mkdirSync(cacheDir, { recursive: true });
    console.log(`Downloading Pumpkin ${PUMPKIN_RELEASE} (${asset})...`);
    const res = await fetch(downloadUrl(asset));
    if (!res.ok) throw new Error(`Downloading ${asset} failed: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    verifyChecksum(asset, bytes, expected);

    // Write to a temp name first so a concurrent or interrupted run never sees a partial file.
    const partial = `${target}.${process.pid}.partial`;
    fs.writeFileSync(partial, bytes, { mode: 0o755 });
    fs.renameSync(partial, target);
    return target;
}
