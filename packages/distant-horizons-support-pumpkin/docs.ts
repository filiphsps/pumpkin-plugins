import type { DocumentSpec } from '@pumpkin-plugins/docs/node';
import { SESSION_TIMING } from '@pumpkin-plugins/pumpkin-pie-api';
import { dhsPlaceholderDefinitions } from './src/placeholders/definitions.ts';

const generatedNote =
    '<!-- Generated from src/placeholders/definitions.ts and the PumpkinPIE session timing constants. Run `pnpm readme`. -->';

/** Formats the retry interval as a short human-readable duration. */
function formatDuration(milliseconds: number): string {
    const minutes = milliseconds / 60_000;
    if (Number.isInteger(minutes)) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;

    const seconds = milliseconds / 1_000;
    if (Number.isInteger(seconds)) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
    return `${milliseconds} ms`;
}

/** Builds the placeholder reference from the service's typed name and description table. */
function renderPlaceholderGuide(): string {
    const rows = dhsPlaceholderDefinitions.map(({ name, description }) => `| \`%dhs_${name}%\` | ${description} |`);
    const table = ['| Placeholder | Meaning |', '| --- | --- |', ...rows].join('\n');
    const retryDelay = formatDuration(SESSION_TIMING.maxRetryMs);
    const heartbeat = formatDuration(SESSION_TIMING.defaultPingMs);

    return [
        '# PumpkinPIE placeholders',
        '',
        'Distant Horizons Support optionally registers the `dhs` namespace with PumpkinPIE. Every',
        'placeholder takes no argument and returns an unlocalized base-10 string. A known zero is `0`.',
        'Unknown names and supplied arguments are declined.',
        '',
        table,
        '',
        'All placeholders except `%dhs_client_connected%` work with or without a viewer.',
        '`%dhs_client_connected%` uses the exact, case-sensitive player name supplied by PumpkinPIE',
        'and returns `false` when that name has no active DH session. It is declined when no viewer is',
        'supplied. The viewer name is status context, not an authorization check.',
        '',
        'These values are available to trusted plugins that can resolve PumpkinPIE placeholders; they',
        'do not inherit the operator permissions for `/dhs` commands.',
        '',
        'For example, a scoreboard or chat format can include:',
        '',
        '```text',
        'DH clients: %dhs_clients%; pending LOD requests: %dhs_pending_requests%',
        'Memory cache: %dhs_memory_bytes% bytes across %dhs_memory_entries% entries',
        'My DH session: %dhs_client_connected%',
        '```',
        '',
        'PumpkinPIE is optional. Without it, Distant Horizons Support still loads and handles DH',
        'traffic. The plugin probes for PumpkinPIE with bounded exponential retry; after retries reach',
        `the cap, another attempt is scheduled no sooner than ${retryDelay} later. It recovers automatically`,
        'on a scheduled attempt after PumpkinPIE becomes available. A ready integration sends its',
        `heartbeat every ${heartbeat}. No PumpkinPIE dependency is required in the host plugin metadata.`,
    ].join('\n');
}

/** Generated placeholder reference derived from the runtime definitions and shared retry policy. */
export const documents = [
    {
        file: 'docs/placeholders.md',
        blocks: { placeholders: renderPlaceholderGuide() },
        note: generatedNote,
    },
] satisfies DocumentSpec[];
