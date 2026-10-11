import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readTarget } from '../../../scripts/pumpkin-targets.mjs';
import { REPO_ROOT } from './repo-root.ts';
import { assetName, parseChecksums } from './util.ts';

/**
 * Returns the Pumpkin binary to test against: `PUMPKIN_BIN` if set, otherwise the pinned
 * profile server, cached in `PUMPKIN_CACHE_DIR` (default `<repo>/.cache/pumpkin`) and
 * verified against its pinned digest or release checksum manifest.
 */
export async function resolvePumpkinBinary({
    root = REPO_ROOT,
    target: targetName
}: {
    root?: string;
    target?: string;
} = {}): Promise<string> {
    const override = process.env.PUMPKIN_BIN;
    if (override) {
        if (!fs.existsSync(override)) throw new Error(`PUMPKIN_BIN does not exist: ${override}`);
        return path.resolve(override);
    }

    const { server } = readTarget(root, targetName);
    const release = server.tag;
    const downloadUrl = (file: string): string =>
        `https://github.com/${server.repository}/releases/download/${encodeURIComponent(release)}/${file}`;
    const asset = assetName(process.platform, process.arch);
    const cacheDir = process.env.PUMPKIN_CACHE_DIR ?? path.join(root, '.cache/pumpkin');
    const pinned = server.sha256?.[asset];
    if (server.sha256 && !pinned) throw new Error(`No pinned digest for ${asset} in Pumpkin target ${release}`);
    const identity = pinned ? `${server.ref}-${pinned}` : release;
    const target = path.join(cacheDir, `${identity}-${asset}`);
    if (fs.existsSync(target)) {
        if (pinned) {
            const actual = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
            if (actual !== pinned) {
                fs.rmSync(target);
                throw new Error(`Checksum mismatch in cached ${asset}: expected ${pinned}, got ${actual}`);
            }
        }
        return target;
    }

    fs.mkdirSync(cacheDir, { recursive: true });
    const expected = pinned ?? parseChecksums(await fetchText(downloadUrl('checksums.sha256'))).get(asset);
    if (!expected) throw new Error(`checksums.sha256 for ${release} has no entry for ${asset}`);

    console.log(`Downloading Pumpkin ${release} (${asset})...`);
    const res = await fetch(downloadUrl(asset));
    if (!res.ok) throw new Error(`Downloading ${asset} failed: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) {
        throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
    }

    // Write to a temp name first so a concurrent or interrupted run never sees a partial file.
    const partial = `${target}.${randomUUID()}.partial`;
    fs.writeFileSync(partial, bytes, { mode: 0o755 });
    fs.renameSync(partial, target);
    return target;
}

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
    return res.text();
}
