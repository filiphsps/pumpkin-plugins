import * as path from 'node:path';
import { ensurePumpkinWit } from '../src/wit.mjs';

/**
 * Fetch the pinned Pumpkin WIT into the repository cache once, before the unit workers start. The
 * type generation test runs gen-types with an empty `PUMPKIN_PLUGINS_CACHE_DIR`, so gen-types reads
 * this cache, and on a cold cache the Git fetch can take longer than the test's timeout.
 */
export default function setup(): void {
    // Make Git give up on a fetch that stalls for 30 s, instead of waiting for the CI job timeout.
    process.env.GIT_HTTP_LOW_SPEED_LIMIT ??= '1';
    process.env.GIT_HTTP_LOW_SPEED_TIME ??= '30';
    const apiRoot = path.resolve(import.meta.dirname, '..');
    ensurePumpkinWit({ lockFile: path.join(apiRoot, 'wit.lock.json'), cacheRoot: path.join(apiRoot, '../../.cache') });
}
