/** A rectangular area expressed in absolute block coordinates. */
export interface TerrainRegion {
    depth: number;
    height: number;
    minY: number;
    originX: number;
    originZ: number;
    width: number;
}

/** A sampled material and its light values. */
export interface TerrainSample {
    blockLight: number;
    material: string;
    skyLight: number;
}

/** Terrain values exposed by a host adapter during one capture step. */
export interface TerrainSource {
    height: number;
    minY: number;
    sample(x: number, y: number, z: number): TerrainSample;
    /** Inclusive world Y of the highest non-empty block in a column. */
    top?(x: number, z: number): number;
}

/** Terrain source plus an optional check that a region can be sampled. */
export interface TerrainAccess extends TerrainSource {
    prepare?(region: TerrainRegion): TerrainPreparationResult;
}

/** Whether a rectangular terrain region is ready to sample. */
export type TerrainPreparationResult =
    | { status: 'ready' }
    | { status: 'pending' }
    | { status: 'unavailable'; reason: string };

/** One run of material and light values within a captured column. */
export interface TerrainSegment {
    blockLight: number;
    height: number;
    materialId: number;
    skyLight: number;
    /** Relative Y of the lowest block in this run. */
    startY: number;
}

/** A completed capture with a shared material table and one segment list per column. */
export interface TerrainCaptureResult {
    columns: TerrainSegment[][];
    materials: string[];
}

/** Options controlling material grouping and the retained segment limit. */
export interface TerrainCaptureOptions {
    /** Identifies empty material values so air above a height bound can be skipped. */
    isEmpty?: (material: string) => boolean;
    /** Maximum number of segments retained across the full region. */
    maxSegments?: number;
}

const DEFAULT_MAX_SEGMENTS = 131_072;

/** Builds bounded column data incrementally from a host-provided terrain source. */
export class TerrainCapture {
    private readonly area: number;
    private readonly columns: TerrainSegment[][] = [];
    private readonly materialIds = new Map<string, number>();
    private readonly materials: string[] = [];
    private readonly isEmpty: (material: string) => boolean;
    private readonly maxSegments: number;
    private column = 0;
    private y: number;
    private segmentCount = 0;
    private sampled = 0;

    /**
     * Initializes an empty capture that starts at the highest Y of the first column.
     *
     * @param region - Absolute block origin and dimensions to capture.
     * @param options - Optional empty-material predicate and retained segment limit.
     * @throws If the region or segment limit is invalid.
     */
    constructor(
        private readonly region: TerrainRegion,
        options: TerrainCaptureOptions = {},
    ) {
        const { width, depth, height } = region;
        if (
            !Number.isSafeInteger(region.originX) ||
            !Number.isSafeInteger(region.originZ) ||
            !Number.isSafeInteger(region.minY) ||
            !Number.isSafeInteger(region.originX + (width - 1)) ||
            !Number.isSafeInteger(region.originZ + (depth - 1)) ||
            !Number.isSafeInteger(region.minY + (height - 1)) ||
            !Number.isSafeInteger(width) ||
            !Number.isSafeInteger(depth) ||
            !Number.isSafeInteger(height) ||
            width < 1 ||
            depth < 1 ||
            height < 1 ||
            !Number.isSafeInteger(width * depth * height)
        ) {
            throw new RangeError('Invalid terrain region');
        }
        this.area = width * depth;
        this.y = height - 1;
        this.isEmpty = options.isEmpty ?? (() => false);
        this.maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS;
        if (!Number.isSafeInteger(this.maxSegments) || this.maxSegments < 1) {
            throw new RangeError('Invalid terrain segment limit');
        }
    }

    /** Samples at most the requested number of blocks and reports when the region is complete. */
    step(source: TerrainSource, budget: number): boolean {
        if (source.minY !== this.region.minY || source.height !== this.region.height) {
            throw new Error('World height changed');
        }
        if (!Number.isSafeInteger(budget) || budget < 0) throw new RangeError('Invalid terrain sample budget');

        for (let remaining = budget; remaining > 0 && this.column < this.area; remaining--) {
            const x = this.region.originX + Math.floor(this.column / this.region.depth);
            const z = this.region.originZ + (this.column % this.region.depth);
            const sample = source.sample(x, this.region.minY + this.y, z);
            this.sampled++;
            let span = 1;
            if (this.y === this.region.height - 1 && source.top && this.isEmpty(sample.material)) {
                const top = source.top(x, z);
                if (!Number.isInteger(top)) throw new Error('Invalid terrain heightmap');
                const firstAir = Math.max(0, Math.min(this.region.height - 1, top - this.region.minY + 1));
                span = Math.max(1, this.y - firstAir);
            }

            let materialId = this.materialIds.get(sample.material);
            if (materialId === undefined) {
                materialId = this.materials.length;
                this.materials.push(sample.material);
                this.materialIds.set(sample.material, materialId);
            }
            const column = this.columns[this.column] ?? [];
            this.columns[this.column] = column;
            const previous = column[column.length - 1];
            if (
                previous?.materialId === materialId &&
                previous.skyLight === sample.skyLight &&
                previous.blockLight === sample.blockLight
            ) {
                previous.startY = this.y - span + 1;
                previous.height += span;
            } else {
                if (++this.segmentCount > this.maxSegments) throw new RangeError('Terrain region is too complex');
                column.push({
                    materialId,
                    startY: this.y - span + 1,
                    height: span,
                    skyLight: sample.skyLight,
                    blockLight: sample.blockLight,
                });
            }

            this.y -= span;
            if (this.y < 0) {
                this.y = this.region.height - 1;
                this.column++;
            }
        }
        return this.column === this.area;
    }

    /** Returns how many blocks all steps have sampled so far, for budgets that track work per sample. */
    samples(): number {
        return this.sampled;
    }

    /** Returns the fraction of the region covered, including any collapsed spans. */
    progress(): number {
        const coveredBlocks = this.column * this.region.height + this.region.height - 1 - this.y;
        return coveredBlocks / (this.area * this.region.height);
    }

    /** Returns the captured material table and columns after sampling has finished. */
    result(): TerrainCaptureResult {
        if (this.column !== this.area) throw new Error('Terrain capture is incomplete');
        return {
            materials: [...this.materials],
            columns: this.columns.map((column) => column.map((segment) => ({ ...segment }))),
        };
    }
}
