import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { SECTION_SIZE_BLOCKS } from '../protocol/constants.ts';

/** Formats a LOD's world section and block origin for diagnostic messages. */
export function lodLocation(level: string, sectionX: number, sectionZ: number): string {
    const blockX = sectionX * SECTION_SIZE_BLOCKS;
    const blockZ = sectionZ * SECTION_SIZE_BLOCKS;
    return `${ansi.named.identifier(level)} section ${ansi.named.number(sectionX)}, ${ansi.named.number(sectionZ)} (origin ${ansi.named.number(blockX)}, ${ansi.named.number(blockZ)} blocks)`;
}
