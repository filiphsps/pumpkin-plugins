import { commandInfos, type PluginInfo } from '@pumpkin-plugins/docs';
import { commands } from './commands/spec.ts';
import { configInfo } from './config/schema.ts';
import { MAX_POINTS_PER_SECTION } from './lod/constants.ts';
import { PLUGIN_NAME } from './name.ts';
import {
    DH_VERSION,
    MAX_TRANSFER_MESSAGE_BYTES,
    PROTOCOL,
    SECTION_CHUNK_COUNT,
    SECTION_SIZE_BLOCKS,
    TRANSFER_FRAGMENT_OVERHEAD_BYTES,
    TRANSFER_FRAGMENT_SAFE_WINDOW_MS,
    TRANSFER_PACKET_BYTES,
} from './protocol/constants.ts';

/**
 * Plugin metadata used by Pumpkin and the generated README.
 */
export const info = {
    name: PLUGIN_NAME,
    description:
        'This unofficial integration lets Java players use Distant Horizons with terrain from your Pumpkin server.',
    permissions: [
        { name: 'fs.read.data', reason: 'Read settings and cached LOD terrain.' },
        { name: 'fs.write.data', reason: 'Write settings and persist captured LOD terrain.' },
    ],
    commands: commandInfos(commands),
    config: configInfo,
    blocks: {
        compatibility: [
            `Targets Distant Horizons **${DH_VERSION}**, using network protocol ${PROTOCOL} on Java Edition.`,
            'Bedrock players do not open DH sessions. Install the Distant Horizons client mod separately.',
            'A client using another DH protocol is disconnected with an incompatibility message.',
            'DH sessions open only in worlds whose names are at most 150 characters of ASCII letters, digits, `_` and `-`, optionally split by one `:` as in `minecraft:overworld`. In other worlds the plugin logs a warning and the client gets no LODs.',
            `The protocol format follows [Distant Horizons core ${DH_VERSION}](https://gitlab.com/distant-horizons-team/distant-horizons-core/-/tree/${DH_VERSION}).`,
        ].join(' '),
        terrain: [
            `The plugin builds LOD sections of ${SECTION_SIZE_BLOCKS} × ${SECTION_SIZE_BLOCKS} blocks, which covers ${SECTION_CHUNK_COUNT} server chunks.`,
            `It captures a section only while all ${SECTION_CHUNK_COUNT} chunks are loaded, and it cannot load or generate distant chunks.`,
            'A request for unloaded terrain stays pending and retries with exponential backoff until the chunks load or the client cancels it.',
            'Loaded terrain that contains only air is valid and gets cached.',
            'By default, each column uses its surface biome.',
            'Set `sample_biomes_3d = true` under `[worlds."<world>"]` to sample cave and other vertical biomes. This adds one biome lookup for each sampled block.',
            'Blocks placed or broken by players, crop growth and fire spread invalidate the affected cached sections.',
            'Other world changes can stay cached until the next refresh when the pinned Pumpkin API does not report their exact world and position.',
            `A section holds at most ${MAX_POINTS_PER_SECTION} material segments, and a transfer packet carries at most ${TRANSFER_PACKET_BYTES} data bytes.`,
            `When a client sets a bandwidth limit, the plugin sizes each fragment, including its ${TRANSFER_FRAGMENT_OVERHEAD_BYTES}-byte protocol envelope, to fit in ${TRANSFER_FRAGMENT_SAFE_WINDOW_MS / 1000} seconds of credit.`,
            `The credit bucket holds at most one full ${MAX_TRANSFER_MESSAGE_BYTES}-byte fragment message.`,
        ].join(' '),
    },
} satisfies PluginInfo<typeof PLUGIN_NAME>;
