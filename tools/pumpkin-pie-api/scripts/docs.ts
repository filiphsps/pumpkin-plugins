import { readFileSync, writeFileSync } from 'node:fs';
import { applyBlocks } from '../../docs/src/blocks.ts';
import type { LIMITS } from '../src/protocol.ts';
import type { SESSION_TIMING } from '../src/session-timing.ts';
import type { PIE_RELEASE } from '../test/provider.ts';

interface Metadata {
    release: { [Key in keyof typeof PIE_RELEASE]: string };
    protocol: number;
    limits: { [Key in keyof typeof LIMITS]: number };
    license: string;
    timing: { [Key in keyof typeof SESSION_TIMING]: number };
}

/** Render protocol facts and integration provenance from their owning metadata. */
export function renderDocs({ release, protocol, limits, license, timing }: Metadata): Record<string, string> {
    const upstream = 'https://github.com/Rennex07/PumpkinPIE';
    return {
        overview: `Host-independent TypeScript client, expansion router and recovery session for
[PumpkinPIE](${upstream}) protocol ${protocol}.`,
        scheduling: `The session starts unavailable. Call \`tick()\` explicitly with a monotonic millisecond clock; there
are no global timers. Failed attempts use exponential backoff (${timing.initialRetryMs}–${timing.maxRetryMs} ms).
Successful sessions ping and renew desired registrations every
${timing.defaultPingMs} ms by default (\`pingIntervalMs\`: ${timing.minPingMs}–${timing.maxPingMs} ms).`,
        limits: `| Limit | Maximum |
| --- | --- |
| Encoded message | ${limits.message} bytes |
| Input/output text | ${limits.text} bytes |
| Identifier, name, namespace, viewer or argument | ${limits.id} bytes |
| Lines per batch | ${limits.batch} |
| Expansion TTL cap | ${limits.ttl} ms |`,
        provenance: `Global setup downloads the exact
[PumpkinPIE ${release.tag} release](${upstream}/releases/tag/${release.tag}), never \`latest\`,
and verifies its SHA-256 before loading it. The provider and server are resolved before workers start.
The provider is cached at \`.cache/pumpkin-pie/${release.tag}-${release.asset}\`; cached bytes are also
verified on every resolution. An interrupted or rejected download never becomes the cached artifact.
A checksum mismatch fails the run rather than silently selecting another release.

| Provenance | Pin |
| --- | --- |
| Provider asset | \`${release.asset}\` |
| Release tag | \`${release.tag}\` |
| Provider source commit | [\`${release.sourceCommit}\`](${upstream}/tree/${release.sourceCommit}) |
| SHA-256 | \`${release.sha256}\` |
| Provider license | ${release.license} |
| Target Pumpkin release | \`${release.pumpkinRelease}\` |
| Target Pumpkin source commit | \`${release.pumpkinCommit}\` |
| Target API artifact | \`@pumpkinmc/pumpkin-api-ts\` ${release.apiArtifact} |
| Workspace tool license | ${license} |

The pinned provider's [protocol contract](${upstream}/blob/${release.sourceCommit}/docs/protocol.md)
and [wire definitions](${upstream}/blob/${release.sourceCommit}/crates/pumpkin-pie/src/protocol.rs)
document the external protocol. No Rust implementation is translated or vendored.
Provider artifacts stay external and ignored, outside the workspace tool's production exports and shipped source files.`
    };
}

/** Update generated blocks, or report stale content without writing in check mode. */
export function updateDoc(file: string, blocks: Record<string, string>, check: boolean): boolean {
    const original = readFileSync(file, 'utf8');
    for (const name of Object.keys(blocks)) {
        if (!original.includes(`<!-- docs:begin ${name} -->`)) throw new Error(`${file}: missing ${name} block`);
    }
    const next = applyBlocks(
        original,
        blocks,
        file,
        '<!-- Generated from protocol/session constants, test/provider.ts and package.json. Run `pnpm readme`. -->'
    );
    if (next === original) return true;
    if (check) return false;
    writeFileSync(file, next);
    return true;
}
