import { createRequire } from 'node:module';
import * as path from 'node:path';
import { ensurePumpkinWit } from '@pumpkin-plugins/pumpkin-api/wit';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
    export interface ProvidedContext {
        pumpkinWitDir: string;
    }
}

/**
 * Resolve the pinned Pumpkin WIT once, before the unit workers start. On a cold cache this fetches it
 * with Git, which can take longer than a test timeout on a CI runner.
 */
export default function setup(project: TestProject): void {
    // Make Git give up on a fetch that stalls for 30 s, instead of waiting for the CI job timeout.
    process.env.GIT_HTTP_LOW_SPEED_LIMIT ??= '1';
    process.env.GIT_HTTP_LOW_SPEED_TIME ??= '30';
    const apiRoot = path.dirname(createRequire(import.meta.url).resolve('@pumpkin-plugins/pumpkin-api/package.json'));
    project.provide(
        'pumpkinWitDir',
        ensurePumpkinWit({
            lockFile: path.join(apiRoot, 'wit.lock.json'),
            cacheRoot: process.env.PUMPKIN_PLUGINS_CACHE_DIR || path.join(apiRoot, '../../.cache'),
        }),
    );
}
