import { ansi } from '@pumpkin-plugins/minecraft-colors';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import type { TerrainAccess, TerrainRegion, TerrainSource } from '@pumpkin-plugins/terrain';
import { PLUGIN_NAME } from '../name.ts';
import { SECTION_DETAIL, SECTION_SIZE_BLOCKS } from '../protocol/constants.ts';
import type { Section } from '../protocol/messages.ts';
import { LodBuilder } from './builder.ts';
import type { LodCache } from './cache.ts';
import {
    iterateLodSectionsWithin,
    type LodSectionBounds,
    type LodSectionCoordinate,
    MAX_LOD_GENERATION_RADIUS,
    sectionKey
} from './generation.ts';
import { lodLocation } from './location.ts';

const logTag = ansi.named.name(PLUGIN_NAME);

/** Maximum block samples a forced capture attempts in one server tick. */
export const FORCE_BLOCK_SAMPLES_PER_TICK = 32_768;

/** Terrain and reporting access valid only for the duration of a peer callback. */
export interface ForcedLodPeer {
    name: string;
    level: string;
    terrain: TerrainAccess;
    /** Inclusive block-center bounds of the world border. */
    borderBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
    insideBorder(x: number, z: number): boolean;
    report(message: string): void;
}

/** Obtains a fresh player and world handle for a forced-capture tick. */
export interface ForcedLodPeers {
    withPeer(name: string, use: (peer: ForcedLodPeer) => void): boolean;
}

/** Details returned after a forced-capture job is accepted. */
export interface ForcedLodStart {
    centerX: number;
    centerZ: number;
    radius: number;
    sections: number;
}

interface ForcedSection {
    coordinate: LodSectionCoordinate;
    key: string;
    invalidated: boolean;
    builder?: LodBuilder;
}

interface ForcedJob extends ForcedLodStart {
    owner: string;
    level: string;
    coordinates: Generator<LodSectionCoordinate>;
    inBorderSections: number;
    scanned: number;
    current?: ForcedSection;
    skippedOutsideBorder: number;
    skippedAlreadyGenerated: number;
    built: number;
    skipped: number;
    lastReportedStep: number;
}

const MAX_SECTIONS_CHECKED_PER_TICK = 64;

/** Captures operator-requested sections at full work budget without retaining Pumpkin handles. */
export class ForcedLodGeneration {
    private job?: ForcedJob;

    constructor(
        private readonly cache: LodCache,
        private readonly log: Logger,
        private readonly now = Date.now
    ) {}

    /** Starts one bounded, cache-refreshing job around the selected block position. */
    start(peer: ForcedLodPeer, blockX: number, blockZ: number, radius = 0): ForcedLodStart {
        if (this.job) throw new Error('A forced LOD generation job is already running.');
        if (!Number.isSafeInteger(radius) || radius < 0 || radius > MAX_LOD_GENERATION_RADIUS) {
            throw new RangeError(`Radius must be between 0 and ${MAX_LOD_GENERATION_RADIUS} LOD sections.`);
        }
        if (!Number.isSafeInteger(blockX) || !Number.isSafeInteger(blockZ)) {
            throw new RangeError('Block coordinates must be safe integers.');
        }
        const { memoryLimit, diskLimit, memoryEntries, diskEntries } = this.cache.stats();
        if (memoryLimit === 0 && diskLimit === 0) throw new Error('Both LOD cache tiers are disabled.');

        const sections = (radius * 2 + 1) ** 2;
        const centerX = Math.floor(blockX / SECTION_SIZE_BLOCKS);
        const centerZ = Math.floor(blockZ / SECTION_SIZE_BLOCKS);
        const selection = this.validateSelection(peer, blockX, blockZ, radius, memoryEntries + diskEntries);

        this.job = {
            owner: peer.name,
            level: peer.level,
            centerX,
            centerZ,
            radius,
            sections,
            coordinates: iterateLodSectionsWithin(blockX, blockZ, radius, selection.bounds),
            inBorderSections: selection.inBorderSections,
            scanned: 0,
            skippedOutsideBorder: sections - selection.inBorderSections,
            skippedAlreadyGenerated: 0,
            built: 0,
            skipped: 0,
            lastReportedStep: 0
        };
        this.log.info(`Started forced LOD capture for ${peer.name}: ${sections} requested sections in ${peer.level}.`);
        return { centerX, centerZ, radius, sections };
    }

    /** Advances the active job, returning true when this tick was reserved for forced work. */
    tick(peers: ForcedLodPeers): boolean {
        const job = this.job;
        if (!job) return false;

        const found = peers.withPeer(job.owner, (peer) => {
            if (peer.level !== job.level) {
                this.sendReport(peer, 'Forced LOD capture cancelled because you changed worlds.');
                this.job = undefined;
                return;
            }
            this.advance(job, peer);
        });
        if (!found && this.job === job) {
            this.log.info(`Cancelled forced LOD capture for ${job.owner}: player is no longer available.`);
            this.job = undefined;
        }
        return true;
    }

    /** Describes the active operator job for `/dhs status`. */
    status(): string | undefined {
        const job = this.job;
        if (!job) return undefined;
        const target = job.current;
        const partial = target?.builder?.progress() ?? 0;
        const progress = Math.floor(((this.completed(job) + partial) / job.sections) * 100);
        const section = target
            ? `; section ${target.coordinate.x}, ${target.coordinate.z} at ${(partial * 100).toFixed(1)}%`
            : '';
        return `Forced LOD capture for ${job.owner}: ${progress}% (${job.built} built, ${this.skipped(job)} skipped of ${job.sections})${section}.`;
    }

    /** Marks an active section obsolete when a block changes during its capture. */
    changed(level: string, x: number, z: number): void {
        const job = this.job;
        const target = job?.current;
        if (
            job?.level === level &&
            target?.key === sectionKey(level, Math.floor(x / SECTION_SIZE_BLOCKS), Math.floor(z / SECTION_SIZE_BLOCKS))
        ) {
            target.invalidated = true;
            this.log.debug(
                `${logTag} Invalidated forced LOD for ${ansi.named.name(job.owner)} at ${lodLocation(level, target.coordinate.x, target.coordinate.z)} after a block change.`
            );
        }
    }

    /** Cancels an owner's job when they disconnect. */
    left(name: string): void {
        if (this.job?.owner !== name) return;
        this.job = undefined;
        this.log.info(`Cancelled forced LOD capture for ${name}: player disconnected.`);
    }

    private advance(job: ForcedJob, peer: ForcedLodPeer): void {
        let budget = FORCE_BLOCK_SAMPLES_PER_TICK;
        let sectionsChecked = 0;
        while (sectionsChecked < MAX_SECTIONS_CHECKED_PER_TICK) {
            let target = job.current;
            if (!target) {
                const next = job.coordinates.next();
                if (next.done) break;
                job.scanned++;
                sectionsChecked++;
                const coordinate = next.value;
                const key = sectionKey(job.level, coordinate.x, coordinate.z);
                if (!isInsideBorder(peer, coordinate)) {
                    job.skippedOutsideBorder++;
                    continue;
                }
                if (this.cache.get(key)) {
                    job.skippedAlreadyGenerated++;
                    continue;
                }
                target = { coordinate, key, invalidated: false };
                job.current = target;
            }
            if (target.invalidated) {
                this.log.debug(
                    `${logTag} Skipped invalidated forced LOD for ${ansi.named.name(job.owner)} at ${lodLocation(job.level, target.coordinate.x, target.coordinate.z)}.`
                );
                job.skipped++;
                job.current = undefined;
                continue;
            }
            if (budget === 0) break;

            try {
                const region = this.region(target.coordinate, peer.terrain);
                const prepared = peer.terrain.prepare?.(region);
                if (prepared?.status === 'pending') break;
                if (prepared && prepared.status !== 'ready') {
                    this.skip(job, prepared.reason);
                    continue;
                }

                target.builder ??= new LodBuilder(section(target.coordinate), region.minY, region.height);
                const measured = measureTerrain(peer.terrain);
                const complete = target.builder.step(measured.source, budget);
                budget -= measured.samples();
                if (!complete) break;

                const stillPrepared = peer.terrain.prepare?.(region);
                if (stillPrepared?.status === 'pending') break;
                if (stillPrepared && stillPrepared.status !== 'ready') {
                    this.skip(job, stillPrepared.reason);
                    continue;
                }

                const data = target.builder.finish(this.now());
                this.cache.put(target.key, { updated: this.now(), data });
                this.log.debug(
                    `${logTag} Built forced LOD for ${ansi.named.name(peer.name)} at ${lodLocation(job.level, target.coordinate.x, target.coordinate.z)} (${ansi.named.number(data.length)} bytes).`
                );
                job.built++;
                job.current = undefined;
            } catch (err) {
                this.skip(job, String(err));
            }
        }

        if (job.scanned === job.inBorderSections && !job.current) {
            this.finish(job, peer);
            return;
        }
        this.reportProgress(job, peer);
    }

    private region(section: LodSectionCoordinate, terrain: TerrainAccess): TerrainRegion {
        return {
            originX: section.x * SECTION_SIZE_BLOCKS,
            originZ: section.z * SECTION_SIZE_BLOCKS,
            width: SECTION_SIZE_BLOCKS,
            depth: SECTION_SIZE_BLOCKS,
            minY: terrain.minY,
            height: terrain.height
        };
    }

    private skip(job: ForcedJob, reason: string): void {
        const target = job.current;
        job.skipped++;
        job.current = undefined;
        if (target) {
            this.log.debug(
                `${logTag} Skipped forced LOD for ${ansi.named.name(job.owner)} at ${lodLocation(job.level, target.coordinate.x, target.coordinate.z)}: ${reason}.`
            );
        }
    }

    private reportProgress(job: ForcedJob, peer: ForcedLodPeer): void {
        const target = job.current;
        const partial = target?.builder?.progress() ?? 0;
        const step = Math.floor(((this.completed(job) + partial) / job.sections) * 10);
        if (step <= job.lastReportedStep || step >= 10) return;
        job.lastReportedStep = step;
        this.sendReport(
            peer,
            `Forced LOD capture ${step * 10}% (${this.completed(job)}/${job.sections} sections complete).`
        );
    }

    private finish(job: ForcedJob, peer: ForcedLodPeer): void {
        if (job.built === 0 && job.skipped === 0) {
            let message: string | undefined;
            if (job.skippedOutsideBorder === job.sections) {
                message = 'No requested LOD sections are inside the world border.';
            } else if (job.skippedAlreadyGenerated + job.skippedOutsideBorder === job.sections) {
                message = 'All requested LOD sections are already generated.';
            }
            if (message) {
                this.sendReport(peer, message);
                this.log.info(
                    `${message} World ${job.level}, center ${job.centerX}, ${job.centerZ}, radius ${job.radius}.`
                );
                this.job = undefined;
                return;
            }
        }
        const skipped = this.skipped(job);
        const message = `Forced LOD capture complete: ${job.built} built, ${skipped} skipped (${job.skippedAlreadyGenerated} already generated).`;
        this.sendReport(peer, message);
        this.log.info(`${message} World ${job.level}, center ${job.centerX}, ${job.centerZ}, radius ${job.radius}.`);
        this.job = undefined;
    }

    private completed(job: ForcedJob): number {
        return job.built + this.skipped(job);
    }

    private skipped(job: ForcedJob): number {
        return job.skipped + job.skippedOutsideBorder + job.skippedAlreadyGenerated;
    }

    private validateSelection(
        peer: ForcedLodPeer,
        blockX: number,
        blockZ: number,
        radius: number,
        maxCachedSections: number
    ): { bounds: LodSectionBounds; inBorderSections: number } {
        const centerX = Math.floor(blockX / SECTION_SIZE_BLOCKS);
        const centerZ = Math.floor(blockZ / SECTION_SIZE_BLOCKS);
        const bounds = peer.borderBounds;
        const minX = Math.max(centerX - radius, Math.ceil((bounds.minX - 0.5) / SECTION_SIZE_BLOCKS));
        const maxX = Math.min(
            centerX + radius,
            Math.floor((bounds.maxX - SECTION_SIZE_BLOCKS + 0.5) / SECTION_SIZE_BLOCKS)
        );
        const minZ = Math.max(centerZ - radius, Math.ceil((bounds.minZ - 0.5) / SECTION_SIZE_BLOCKS));
        const maxZ = Math.min(
            centerZ + radius,
            Math.floor((bounds.maxZ - SECTION_SIZE_BLOCKS + 0.5) / SECTION_SIZE_BLOCKS)
        );
        if (minX > maxX || minZ > maxZ) throw new Error('No requested LOD sections are inside the world border.');

        const inBorderSections = (maxX - minX + 1) * (maxZ - minZ + 1);
        if (inBorderSections > maxCachedSections) return { bounds: { minX, maxX, minZ, maxZ }, inBorderSections };

        let alreadyGenerated = 0;
        for (let x = minX; x <= maxX; x++) {
            for (let z = minZ; z <= maxZ; z++) {
                if (this.cache.get(sectionKey(peer.level, x, z))) alreadyGenerated++;
            }
        }
        if (alreadyGenerated === inBorderSections) {
            throw new Error('All requested LOD sections are already generated.');
        }
        return { bounds: { minX, maxX, minZ, maxZ }, inBorderSections };
    }

    private sendReport(peer: ForcedLodPeer, message: string): void {
        try {
            peer.report(message);
        } catch (err) {
            this.log.warn(`Could not report forced LOD progress to ${peer.name}: ${String(err)}`);
        }
    }
}

function isInsideBorder(peer: ForcedLodPeer, coordinate: LodSectionCoordinate): boolean {
    const minX = coordinate.x * SECTION_SIZE_BLOCKS;
    const minZ = coordinate.z * SECTION_SIZE_BLOCKS;
    return (
        peer.insideBorder(minX, minZ) &&
        peer.insideBorder(minX + SECTION_SIZE_BLOCKS - 1, minZ + SECTION_SIZE_BLOCKS - 1)
    );
}

function section(coordinate: LodSectionCoordinate): Section {
    const x = coordinate.x & 0x0fff_ffff;
    const z = coordinate.z & 0x0fff_ffff;
    return {
        x: coordinate.x,
        z: coordinate.z,
        detail: SECTION_DETAIL,
        high: ((z << 4) | (x >>> 24)) >>> 0,
        low: ((x << 8) | SECTION_DETAIL) >>> 0
    };
}

function measureTerrain(source: TerrainSource): { source: TerrainSource; samples: () => number } {
    let samples = 0;
    const measured: TerrainSource = {
        minY: source.minY,
        height: source.height,
        sample: (x, y, z) => {
            samples++;
            return source.sample(x, y, z);
        }
    };
    if (source.top) measured.top = source.top.bind(source);
    return { source: measured, samples: () => samples };
}
