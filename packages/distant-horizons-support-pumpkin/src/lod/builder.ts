/*
 * DH DTO serialization adapted from DH Support FullBuilder and Lod. Copyright (C) 2024 Jim C K Flaten.
 * Protocol layout follows Distant Horizons core, Copyright (C) 2020 James Seibel, originally LGPL-3.0-only.
 * This DH-specific encoder remains part of the GPL-licensed plugin; shared capture is protocol-neutral.
 */
import { TerrainCapture, type TerrainSource } from '@pumpkin-plugins/terrain';
import { Writer } from '../protocol/bytes.ts';
import { SECTION_AREA, SECTION_DETAIL } from '../protocol/constants.ts';
import type { Section } from '../protocol/messages.ts';
import { MAX_POINTS_PER_SECTION } from './constants.ts';
import { sectionRegion } from './generation.ts';

const EMPTY_DH_MATERIAL = /_DH-BSW_minecraft:(?:air|void_air)$/;

// Field values for DH core FullDataSourceV2DTO, written in the order of its encode().
/** DTO.dataChecksum, left unset. */
const DATA_CHECKSUM = 0;
/** EDhApiWorldGenerationStep.LIGHT: every column is fully generated. */
const GENERATION_STEP_LIGHT = 9;
/** EDhApiWorldCompressionMode.MERGE_SAME_BLOCKS for every column. */
const WORLD_COMPRESSION_MERGE_SAME_BLOCKS = 0;
/** DTO.DATA_FORMAT.V1_NO_ADJACENT_DATA, so the four adjacent-data arrays stay empty. */
const DATA_FORMAT_V1_NO_ADJACENT_DATA = 1;
/** EDhApiDataCompressionMode.UNCOMPRESSED. */
const DATA_COMPRESSION_UNCOMPRESSED = 0;
const EMPTY = new Uint8Array();

/**
 * Size of a DTO whose arrays are all empty: position, checksum, seven array lengths, format and
 * compression bytes, three flags and two timestamps. Shorter payloads cannot be a DTO.
 */
export const MIN_DTO_BYTES = 8 + 4 + 7 * 4 + 2 + 3 + 2 * 8;

/** Incrementally captures terrain and encodes a completed section for the DH client. */
export class LodBuilder {
    private readonly capture: TerrainCapture;

    constructor(
        private readonly section: Section,
        minY: number,
        height: number,
    ) {
        if (section.detail !== SECTION_DETAIL || height < 1 || height > 4095) {
            throw new RangeError('Unsupported LOD dimensions');
        }
        this.capture = new TerrainCapture(sectionRegion(section, { minY, height }), {
            isEmpty: (material) => EMPTY_DH_MATERIAL.test(material),
            maxSegments: MAX_POINTS_PER_SECTION,
        });
    }

    /** Samples up to budget blocks; returns true once all columns have been built. */
    step(terrain: TerrainSource, budget: number): boolean {
        return this.capture.step(terrain, budget);
    }

    /** Blocks sampled by all steps so far. */
    samples(): number {
        return this.capture.samples();
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
            .int(DATA_CHECKSUM)
            .blob(columnData.finish())
            .blob(EMPTY) // north adjacent data
            .blob(EMPTY) // south adjacent data
            .blob(EMPTY) // east adjacent data
            .blob(EMPTY) // west adjacent data
            .blob(new Uint8Array(SECTION_AREA).fill(GENERATION_STEP_LIGHT))
            .blob(new Uint8Array(SECTION_AREA).fill(WORLD_COMPRESSION_MERGE_SAME_BLOCKS))
            .blob(mappingData.finish())
            .byte(DATA_FORMAT_V1_NO_ADJACENT_DATA)
            .byte(DATA_COMPRESSION_UNCOMPRESSED)
            .bool(true) // applyToParent
            .bool(false) // applyToChildren
            .bool(false) // regenerate
            .timestamp(now) // lastModifiedUnixDateTime
            .timestamp(now) // createdUnixDateTime
            .finish();
    }
}
