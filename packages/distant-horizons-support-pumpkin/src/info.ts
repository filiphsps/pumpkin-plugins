import { commandInfos, type PluginInfo } from '@pumpkin-plugins/docs';
import { commands } from './commands/spec.ts';
import { configInfo } from './config/schema.ts';
import { MAX_POINTS_PER_SECTION } from './lod/constants.ts';
import { PLUGIN_NAME } from './name.ts';
import {
    DH_VERSION,
    PROTOCOL,
    SECTION_CHUNK_COUNT,
    SECTION_SIZE_BLOCKS,
    TRANSFER_PACKET_BYTES
} from './protocol/constants.ts';

/**
 * Plugin metadata used by Pumpkin and the generated README.
 */
export const info = {
    name: PLUGIN_NAME,
    description: 'Unofficial Distant Horizons server support for Pumpkin',
    permissions: [
        { name: 'fs.read.data', reason: 'Read settings and cached LOD terrain.' },
        { name: 'fs.write.data', reason: 'Write settings and persist captured LOD terrain.' }
    ],
    commands: commandInfos(commands),
    config: configInfo,
    blocks: {
        compatibility: [
            `Targets Distant Horizons **${DH_VERSION}**, using network protocol ${PROTOCOL} on Java Edition.`,
            'Bedrock players do not open DH sessions. Install the Distant Horizons client mod separately.',
            'A client using another DH protocol is disconnected with an incompatibility message.',
            `The protocol format follows [Distant Horizons core ${DH_VERSION}](https://gitlab.com/distant-horizons-team/distant-horizons-core/-/tree/${DH_VERSION}).`
        ].join(' '),
        terrain: [
            `The plugin builds LOD sections covering ${SECTION_SIZE_BLOCKS} × ${SECTION_SIZE_BLOCKS} blocks`,
            `across ${SECTION_CHUNK_COUNT} server chunks.`,
            `All ${SECTION_CHUNK_COUNT} chunks must remain loaded by Pumpkin while a capture progresses.`,
            'The plugin cannot load or generate distant chunks.',
            `Captures are limited to ${MAX_POINTS_PER_SECTION} material segments per section,`,
            `and transfer packets carry at most ${TRANSFER_PACKET_BYTES} bytes.`
        ].join(' ')
    }
} satisfies PluginInfo<typeof PLUGIN_NAME>;
