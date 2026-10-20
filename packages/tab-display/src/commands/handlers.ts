import type { CommandSender } from 'pumpkin:plugin/command@0.1.0';
import type { CommandHandlers, CommandPlayerReference } from '@pumpkin-plugins/docs';
import { errorLine } from '@pumpkin-plugins/docs';
import type { TabDisplayStatus } from '../model.ts';
import type { commands } from './spec.ts';

/** Safe diagnostic fields for one online player. */
export interface PlayerInspection {
    readonly edition: string;
    readonly javaVersion?: string;
    readonly name: string;
    readonly placeholderIds: readonly string[];
    readonly uuid: string;
}

/** Command-facing operations, kept independent from WIT resources and file handles. */
export interface TabDisplayCommandRuntime {
    inspect(uuid: string): PlayerInspection | undefined;
    reload(): { readonly kind: 'applied' } | { readonly kind: 'failed'; readonly reason: string };
    status(): TabDisplayStatus;
}

/** Builds the three documented operator command handlers. */
export function commandHandlers(runtime: TabDisplayCommandRuntime): CommandHandlers<typeof commands, CommandSender> {
    return {
        'tabdisplay status': () => formatStatus(runtime.status()),
        'tabdisplay reload': () => {
            const result = runtime.reload();
            return result.kind === 'applied'
                ? ['TabDisplay configuration reloaded.']
                : [errorLine(`TabDisplay reload failed: ${result.reason}`)];
        },
        'tabdisplay inspect <player>': (_sender, { player }) => formatInspection(runtime.inspect, player),
    };
}

function formatStatus(status: TabDisplayStatus): readonly string[] {
    return [
        `Enabled: ${status.enabled}`,
        `Placeholder provider: ${status.provider}`,
        `Players: ${status.players} (Java ${status.javaPlayers}; Bedrock ${status.bedrockPlayers})`,
        `Java versions: ${status.javaVersions.length > 0 ? status.javaVersions.join(', ') : 'none connected'}`,
        `Bedrock: ${formatCapability(status.bedrock)}`,
        `Unresolved placeholder IDs: ${status.unresolved.length > 0 ? status.unresolved.join(', ') : 'none'}`,
        ...(status.lastFailure === undefined ? [] : [`Last failure: ${status.lastFailure}`]),
    ];
}

function formatInspection(
    inspect: (uuid: string) => PlayerInspection | undefined,
    players: readonly CommandPlayerReference[],
): readonly (string | { readonly text: string; readonly tone: 'error' })[] {
    if (players.length !== 1) return [errorLine('Inspect exactly one online player.')];
    const selected = players[0];
    if (selected === undefined) return [errorLine('Inspect exactly one online player.')];
    const data = inspect(selected.id);
    if (data === undefined) return [errorLine('Player is no longer online.')];
    return [
        `Player: ${data.name}`,
        `UUID: ${data.uuid}`,
        `Edition: ${data.edition}`,
        ...(data.javaVersion === undefined ? [] : [`Java version: ${data.javaVersion}`]),
        `Placeholder IDs: ${data.placeholderIds.length > 0 ? data.placeholderIds.join(', ') : 'none'}`,
        'Resolved placeholder values are not shown.',
    ];
}

function formatCapability(capability: TabDisplayStatus['bedrock']): string {
    return capability.kind === 'supported' ? 'supported' : `unsupported (${capability.reason})`;
}
