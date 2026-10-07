/*
 * Adapted from DH Support FullBuilder and Lod. Copyright (C) 2024 Jim C K Flaten.
 * Changes for Pumpkin made in October 2026. SPDX-License-Identifier: GPL-3.0-or-later
 * Free software under GNU GPL version 3 or any later version, WITHOUT ANY WARRANTY.
 * See ../../LICENSE. Protocol DTO layout follows DH core, Copyright (C) 2020
 * James Seibel, originally LGPL-3.0-only; see ../../LICENSE.LESSER.txt.
 */
import { Writer } from '../protocol/bytes.ts';
import { SECTION_AREA, SECTION_DETAIL, SECTION_SIZE_BLOCKS } from '../protocol/constants.ts';
import type { Section } from '../protocol/messages.ts';
import { MAX_POINTS_PER_SECTION } from './constants.ts';

/** A block and biome mapping with the light above its upper face. */
export interface Sample {
    mapping: string;
    sky: number;
    block: number;
}
/** Terrain access supplied by the host adapter, using absolute block coordinates. */
export interface Terrain {
    minY: number;
    height: number;
    sample(x: number, y: number, z: number): Sample;
    /** Checks all required chunks before a capture spends ticks sampling them. */
    prepare?(section: Section): void;
    /** Heightmap bound for the highest non-air block; absent adapters scan the whole column. */
    top?(x: number, z: number): number;
}
interface Point {
    id: number;
    start: number;
    height: number;
    sky: number;
    block: number;
}

/** Incrementally builds the columns of an LOD, with a bounded number of block reads. */
export class LodBuilder {
    private column = 0;
    private points = 0;
    private y: number;
    private readonly columns: Point[][] = [];
    private readonly ids = new Map<string, number>();
    private readonly mappings: string[] = [];
    constructor(
        private readonly section: Section,
        private readonly minY: number,
        private readonly height: number
    ) {
        if (section.detail !== SECTION_DETAIL || height < 1 || height > 4095)
            throw new RangeError('Unsupported LOD dimensions');
        this.y = height - 1;
    }
    /** Reads up to budget blocks; returns true once all columns have been built. */
    step(terrain: Terrain, budget: number): boolean {
        if (terrain.minY !== this.minY || terrain.height !== this.height) throw new Error('World height changed');
        for (let remaining = budget; remaining > 0 && this.column < SECTION_AREA; remaining--) {
            const x = this.section.x * SECTION_SIZE_BLOCKS + Math.floor(this.column / SECTION_SIZE_BLOCKS);
            const z = this.section.z * SECTION_SIZE_BLOCKS + (this.column % SECTION_SIZE_BLOCKS);
            const sample = terrain.sample(x, this.minY + this.y, z);
            let span = 1;
            if (
                this.y === this.height - 1 &&
                terrain.top &&
                /_DH-BSW_minecraft:(?:air|void_air)$/.test(sample.mapping)
            ) {
                const top = terrain.top(x, z);
                if (!Number.isInteger(top)) throw new Error('Invalid terrain heightmap');
                // Keep a block above the heightmap bound: hosts may report either the surface or first air Y.
                const ceiling = Math.max(0, Math.min(this.height - 1, top - this.minY + 1));
                span = Math.max(1, this.y - ceiling);
            }
            const start = this.y - span + 1;
            let id = this.ids.get(sample.mapping);
            if (id === undefined) {
                id = this.mappings.length;
                this.mappings.push(sample.mapping);
                this.ids.set(sample.mapping, id);
            }
            const column = this.columns[this.column] ?? [];
            this.columns[this.column] = column;
            const previous = column[column.length - 1];
            if (previous?.id === id) {
                previous.start = start;
                previous.height += span;
            } else {
                // Bound guest memory even for custom worlds with alternating blocks at every height.
                if (++this.points > MAX_POINTS_PER_SECTION) throw new RangeError('LOD section is too complex');
                column.push({ id, start, height: span, sky: sample.sky, block: sample.block });
            }
            this.y -= span;
            if (this.y < 0) {
                this.y = this.height - 1;
                this.column++;
            }
        }
        return this.column === SECTION_AREA;
    }
    /** Fraction of the section already sampled, including the current column. */
    progress(): number {
        return (this.column * this.height + this.height - 1 - this.y) / (SECTION_AREA * this.height);
    }
    /** Encodes DH's supported v1 DTO with uncompressed blobs and exact packed datapoints. */
    finish(now: number): Uint8Array {
        if (this.column !== 4096) throw new Error('LOD is incomplete');
        const data = new Writer();
        for (const column of this.columns) {
            data.short(column.length);
            for (const p of column) {
                if (p.sky < 0 || p.sky > 15 || p.block < 0 || p.block > 15) throw new Error('Invalid terrain light');
                const high = (p.height | (p.start << 12) | (p.sky << 24) | (p.block << 28)) >>> 0;
                data.words(high, p.id);
            }
        }
        const mappings = new Writer().int(this.mappings.length);
        for (const mapping of this.mappings) mappings.string(mapping);
        // v1 is intentionally retained: the supported DH client decodes it and converts adjacency data.
        return new Writer()
            .words(this.section.high, this.section.low)
            .int(0)
            .blob(data.finish())
            .int(0)
            .int(0)
            .int(0)
            .int(0)
            .blob(new Uint8Array(SECTION_AREA).fill(9))
            .blob(new Uint8Array(SECTION_AREA))
            .blob(mappings.finish())
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
