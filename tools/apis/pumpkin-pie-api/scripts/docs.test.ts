import { expect, it } from 'vitest';
import { PIE_RELEASE } from '../test/release.ts';
import { renderDocs } from './docs.ts';

it('renders changed release pins and protocol limits without stale versions', () => {
    const blocks = renderDocs({
        release: { ...PIE_RELEASE, tag: 'v9.8.7', sourceCommit: 'new-source', asset: 'new.wasm', sha256: 'new-hash' },
        protocol: 7,
        limits: { message: 9000, text: 800, id: 40, batch: 12, ttl: 2000 },
        license: 'Example-license',
        timing: { defaultPingMs: 2500, minPingMs: 500, maxPingMs: 4000, initialRetryMs: 600, maxRetryMs: 5000 },
    });
    expect(blocks.scheduling).toContain('600–5000 ms');
    expect(blocks.scheduling).toContain('2500 ms by default (`pingIntervalMs`: 500–4000 ms)');
    expect(blocks.overview).toContain('protocol 7');
    expect(blocks.provenance).toContain('releases/tag/v9.8.7');
    expect(blocks.provenance).toContain('.cache/pumpkin-pie/v9.8.7-new.wasm');
    expect(blocks.provenance).toContain('`new-hash`');
    expect(blocks.provenance).toContain('blob/new-source/docs/protocol.md');
    expect(blocks.provenance).toContain('Example-license');
    expect(blocks.limits).toContain('| Encoded message | 9000 bytes |');
    expect(blocks.limits).toContain('| Expansion TTL cap | 2000 ms |');
});
