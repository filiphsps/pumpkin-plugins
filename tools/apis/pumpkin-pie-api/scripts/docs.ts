import { code, table } from '@pumpkin-plugins/docs/markdown';
import type { LIMITS } from '../src/protocol.ts';
import type { SESSION_TIMING } from '../src/session-timing.ts';
import type { PIE_RELEASE } from '../test/release.ts';

interface Metadata {
    license: string;
    limits: { [Key in keyof typeof LIMITS]: number };
    protocol: number;
    release: { [Key in keyof typeof PIE_RELEASE]: string };
    timing: { [Key in keyof typeof SESSION_TIMING]: number };
}

/** Render protocol facts and integration provenance from their owning metadata. */
export function renderDocs({ release, protocol, limits, license, timing }: Metadata): Record<string, string> {
    const upstream = 'https://github.com/Rennex07/PumpkinPIE';
    return {
        overview: `Host-independent TypeScript client, expansion router and recovery session for
[PumpkinPIE (EXTERNAL)](${upstream}) protocol ${protocol}.`,
        scheduling: `The session starts unavailable. Call \`tick()\` explicitly with a monotonic millisecond clock; there
are no global timers. Failed attempts use exponential backoff (${timing.initialRetryMs}–${timing.maxRetryMs} ms).
Successful sessions ping and renew desired registrations every
${timing.defaultPingMs} ms by default (\`pingIntervalMs\`: ${timing.minPingMs}–${timing.maxPingMs} ms).`,
        limits: table(
            ['Limit', 'Maximum'],
            [
                ['Encoded message', `${limits.message} bytes`],
                ['Input/output text', `${limits.text} bytes`],
                ['Identifier, name, namespace, viewer or argument', `${limits.id} bytes`],
                ['Lines per batch', String(limits.batch)],
                ['Expansion TTL cap', `${limits.ttl} ms`],
            ],
        ),
        provenance: `Global setup downloads the exact
[PumpkinPIE ${release.tag} release](${upstream}/releases/tag/${release.tag}), never \`latest\`,
and verifies its SHA-256 before loading it. The provider and server are resolved before workers start.
The provider is cached at \`.cache/pumpkin-pie/${release.tag}-${release.asset}\`; cached bytes are also
verified on every resolution. An interrupted or rejected download never becomes the cached artifact.
A checksum mismatch fails the run rather than silently selecting another release.

${table(
    ['Provenance', 'Pin'],
    [
        ['Provider asset', code(release.asset)],
        ['Release tag', code(release.tag)],
        ['Provider source commit', `[${code(release.sourceCommit)}](${upstream}/tree/${release.sourceCommit})`],
        ['SHA-256', code(release.sha256)],
        ['Provider license', release.license],
        ['Target Pumpkin release', code(release.pumpkinRelease)],
        ['Target Pumpkin source commit', code(release.pumpkinCommit)],
        ['Target API artifact', `${code('@pumpkin-plugins/pumpkin-api')} ${release.apiArtifact}`],
        ['Workspace tool license', license],
    ],
)}

The pinned provider's [protocol contract](${upstream}/blob/${release.sourceCommit}/docs/protocol.md)
and [wire definitions](${upstream}/blob/${release.sourceCommit}/crates/pumpkin-pie/src/protocol.rs)
document the external protocol. No Rust implementation is translated or vendored.
Provider artifacts stay external and ignored, outside the workspace tool's production exports and shipped source files.`,
    };
}
