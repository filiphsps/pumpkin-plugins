/*
 * DH DTO serialization adapted from DH Support FullBuilder and Lod. Copyright (C) 2024 Jim C K Flaten.
 * Protocol layout follows Distant Horizons core, Copyright (C) 2020 James Seibel, originally LGPL-3.0-only.
 * This DH-specific encoder remains part of the GPL-licensed plugin; shared capture is protocol-neutral.
 */
import { TerrainCapture, type TerrainSource } from '@pumpkin-plugins/terrain';
import { Writer } from '../protocol/bytes.ts';
import { SECTION_AREA, SECTION_DETAIL, SECTION_SIZE_BLOCKS } from '../protocol/constants.ts';
import type { Section } from '../protocol/messages.ts';
import { MAX_POINTS_PER_SECTION } from './constants.ts';

const EMPTY_DH_MATERIAL = /_DH-BSW_minecraft:(?:air|void_air)$/;

/** Incrementally captures terrain and encodes a completed section for the DH client. */
export class LodBuilder {
    private readonly capture: TerrainCapture;

    constructor(
        private readonly section: Section,
        minY: number,
        height: number
    ) {
        if (section.detail !== SECTION_DETAIL || height < 1 || height > 4095) {
            throw new RangeError('Unsupported LOD dimensions');
        }
        this.capture = new TerrainCapture(
            {
                originX: section.x * SECTION_SIZE_BLOCKS,
                originZ: section.z * SECTION_SIZE_BLOCKS,
                width: SECTION_SIZE_BLOCKS,
                depth: SECTION_SIZE_BLOCKS,
                minY,
                height
            },
            {
                isEmpty: (material) => EMPTY_DH_MATERIAL.test(material),
                maxSegments: MAX_POINTS_PER_SECTION
            }
        );
    }

    /** Samples up to budget blocks; returns true once all columns have been built. */
    step(terrain: TerrainSource, budget: number): boolean {
        return this.capture.step(terrain, budget);
    }

    /** Fraction of the section covered, including collapsed spans. */
    progress(): number {
        return this.capture.progress();
    }

    /** Encodes the captured terrain in the supported DH v1 DTO layout. */
    finish(now: number): Uint8Array {
        const capture = this.capture.result();
        const columnData = new Writer();
        for (const column of capture.columns) {
            columnData.short(column.length);
            for (const segment of column) {
                if (
                    segment.skyLight < 0 ||
                    segment.skyLight > 15 ||
                    segment.blockLight < 0 ||
                    segment.blockLight > 15
                ) {
                    throw new Error('Invalid terrain light');
                }
                const high =
                    (segment.height |
                        (segment.startY << 12) |
                        (segment.skyLight << 24) |
                        (segment.blockLight << 28)) >>>
                    0;
                columnData.words(high, segment.materialId);
            }
        }

        const mappingData = new Writer().int(capture.materials.length);
        for (const material of capture.materials) mappingData.string(material);

        return new Writer()
            .words(this.section.high, this.section.low)
            .int(0)
            .blob(columnData.finish())
            .int(0)
            .int(0)
            .int(0)
            .int(0)
            .blob(new Uint8Array(SECTION_AREA).fill(9))
            .blob(new Uint8Array(SECTION_AREA))
            .blob(mappingData.finish())
            .byte(1)
            .byte(0)
            .bool(true)
            .bool(false)
            .bool(false)
            .timestamp(now)
            .timestamp(now)
            .finish();
    }
}
