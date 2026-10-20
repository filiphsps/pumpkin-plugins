import { type CommandLine, errorLine } from '@pumpkin-plugins/docs';
import {
    describeIdentity,
    formatIpv4,
    type MapperInfo,
    type MappingSpec,
    type MappingState,
} from '@pumpkin-plugins/port-mapping';
import { keyName } from '../keys.ts';
import { refusalMessage } from '../refusal.ts';

/** One requested port with its state, as the mapper reports it. */
export interface MappingLine {
    key: string;
    spec: MappingSpec;
    state: MappingState;
}

function describeState(state: MappingState): string {
    if (state.kind === 'pending') return 'looking for a router';
    if (state.kind === 'failed') return `not open: ${state.reason}`;
    const where = `${formatIpv4(state.address)}:${state.port}`;
    return state.via === 'public'
        ? `reachable at ${where} (this machine has a public address)`
        : `open at ${where} (${state.via})`;
}

/**
 * The lines `/upnp status` prints. A blocked router is reported in red, first.
 * @param info - What the mapper has learned about the network.
 * @param mappings - Every port that was asked for.
 */
export function statusLines(info: MapperInfo, mappings: readonly MappingLine[]): CommandLine[] {
    const lines: CommandLine[] = [];
    if (info.refused) {
        lines.push(errorLine(refusalMessage(info.refused)));
    } else if (info.gateway && info.externalAddress) {
        const model = info.identity ? ` (${describeIdentity(info.identity)})` : '';
        lines.push(
            `Router: ${info.gateway.kind} at ${formatIpv4(info.gateway.address)}${model}, public address ${formatIpv4(info.externalAddress)}.`,
        );
    } else if (info.localAddress) {
        lines.push(`No router found yet. This machine's address is ${formatIpv4(info.localAddress)}.`);
    } else {
        lines.push('No router found yet.');
    }
    if (mappings.length === 0)
        lines.push('No ports were asked for. Turn on java.enabled or bedrock.enabled in config.toml.');
    for (const { key, spec, state } of mappings) {
        const what = `${keyName(key)} (${spec.protocol.toUpperCase()} ${spec.port})`;
        lines.push(info.refused ? `${what}: not opened` : `${what}: ${describeState(state)}`);
    }
    return lines;
}

/**
 * The line `/upnp reload` prints.
 * @param count - How many ports are requested, whatever their state.
 */
export function reloadLines(count: number): CommandLine[] {
    return [
        `Reloaded the config. ${count} port${count === 1 ? '' : 's'} requested; /upnp status shows which are open.`,
    ];
}
