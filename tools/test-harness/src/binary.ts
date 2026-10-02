import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PUMPKIN_RELEASE } from './pumpkin-version.ts';
import { REPO_ROOT } from './repo-root.ts';
import { assetName, parseChecksums } from './util.ts';

function downloadUrl(file: string): string {
    return `https://github.com/Pumpkin-MC/Pumpkin/releases/download/${encodeURIComponent(PUMPKIN_RELEASE)}/${file}`;
}

/**
 * Returns the Pumpkin binary to test against: `PUMPKIN_BIN` if set, otherwise the pinned
 * release, downloaded once into `PUMPKIN_CACHE_DIR` (default `<repo>/.cache/pumpkin`) and
 * verified against the release's checksums.sha256.
 */
export async function resolvePumpkinBinary(): Promise<string> {
    const override = process.env.PUMPKIN_BIN;
    if (override) {
        if (!fs.existsSync(override)) throw new Error(`PUMPKIN_BIN does not exist: ${override}`);
        return path.resolve(override);
    }

    const asset = assetName(process.platform, process.arch);
    const cacheDir = process.env.PUMPKIN_CACHE_DIR ?? path.join(REPO_ROOT, '.cache/pumpkin');
    const target = path.join(cacheDir, `${PUMPKIN_RELEASE}-${asset}`);
    if (fs.existsSync(target)) return target;

    fs.mkdirSync(cacheDir, { recursive: true });
    const sums = parseChecksums(await fetchText(downloadUrl('checksums.sha256')));
    const expected = sums.get(asset);
    if (!expected) throw new Error(`checksums.sha256 for ${PUMPKIN_RELEASE} has no entry for ${asset}`);

    console.log(`Downloading Pumpkin ${PUMPKIN_RELEASE} (${asset})...`);
    const res = await fetch(downloadUrl(asset));
    if (!res.ok) throw new Error(`Downloading ${asset} failed: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) {
        throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
    }

    // Write to a temp name first so a concurrent or interrupted run never sees a partial file.
    const partial = `${target}.${process.pid}.partial`;
    fs.writeFileSync(partial, bytes, { mode: 0o755 });
    fs.renameSync(partial, target);
    return target;
}

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
    return res.text();
}
