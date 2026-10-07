import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import type { TerrainAccess, TerrainRegion, TerrainSource } from '@pumpkin-plugins/terrain';
import { SECTION_DETAIL, SECTION_SIZE_BLOCKS } from '../protocol/constants.ts';
import type { Section } from '../protocol/messages.ts';
import { LodBuilder } from './builder.ts';
import type { LodCache } from './cache.ts';
import { type LodSectionCoordinate, listLodSectionsAround, sectionKey } from './generation.ts';

/** Maximum block samples a forced capture attempts in one server tick. */
export const FORCE_BLOCK_SAMPLES_PER_TICK = 32_768;

/** Terrain and reporting access valid only for the duration of a peer callback. */
export interface ForcedLodPeer {
    name: string;
    level: string;
    terrain: TerrainAccess;
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
    skippedOutsideBorder: number;
}

interface ForcedSection {
    coordinate: LodSectionCoordinate;
    key: string;
    insideBorder: boolean;
    invalidated: boolean;
    builder?: LodBuilder;
}

interface ForcedJob extends ForcedLodStart {
    owner: string;
    level: string;
    targets: ForcedSection[];
    index: number;
    built: number;
    skipped: number;
    lastReportedStep: number;
}

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
        const { memoryLimit, diskLimit } = this.cache.stats();
        if (memoryLimit === 0 && diskLimit === 0) throw new Error('Both LOD cache tiers are disabled.');

        const coordinates = listLodSectionsAround(blockX, blockZ, radius);
        const targets = coordinates.map((coordinate) => {
            const minX = coordinate.x * SECTION_SIZE_BLOCKS;
            const minZ = coordinate.z * SECTION_SIZE_BLOCKS;
            const maxX = minX + SECTION_SIZE_BLOCKS - 1;
            const maxZ = minZ + SECTION_SIZE_BLOCKS - 1;
            return {
                coordinate,
                key: sectionKey(peer.level, coordinate.x, coordinate.z),
                insideBorder: peer.insideBorder(minX, minZ) && peer.insideBorder(maxX, maxZ),
                invalidated: false
            };
        });
        const skippedOutsideBorder = targets.filter((target) => !target.insideBorder).length;
        if (skippedOutsideBorder === targets.length) {
            throw new Error('No requested LOD sections are inside the world border.');
        }

        const centerX = Math.floor(blockX / SECTION_SIZE_BLOCKS);
        const centerZ = Math.floor(blockZ / SECTION_SIZE_BLOCKS);
        this.job = {
            owner: peer.name,
            level: peer.level,
            centerX,
            centerZ,
            radius,
            sections: targets.length,
            skippedOutsideBorder,
            targets,
            index: 0,
            built: 0,
            skipped: 0,
            lastReportedStep: 0
        };
        this.log.info(
            `Started forced LOD capture for ${peer.name}: ${targets.length - skippedOutsideBorder}/${targets.length} sections in ${peer.level}.`
        );
        return { centerX, centerZ, radius, sections: targets.length, skippedOutsideBorder };
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
        const target = job.targets[job.index];
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
        const target = job?.targets[job.index];
        if (
            job?.level === level &&
            target?.key === sectionKey(level, Math.floor(x / SECTION_SIZE_BLOCKS), Math.floor(z / SECTION_SIZE_BLOCKS))
        ) {
            target.invalidated = true;
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
        while (job.index < job.targets.length) {
            const target = job.targets[job.index];
            if (!target) break;
            if (!target.insideBorder) {
                job.index++;
                continue;
            }
            if (target.invalidated) {
                job.skipped++;
                job.index++;
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

                this.cache.put(target.key, { updated: this.now(), data: target.builder.finish(this.now()) });
                job.built++;
                job.index++;
            } catch (err) {
                this.skip(job, String(err));
            }
        }

        if (job.index === job.targets.length) {
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
        job.skipped++;
        job.index++;
        this.log.debug(`Forced LOD section skipped: ${reason}`);
    }

    private reportProgress(job: ForcedJob, peer: ForcedLodPeer): void {
        const target = job.targets[job.index];
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
        const skipped = this.skipped(job);
        const message = `Forced LOD capture complete: ${job.built} built, ${skipped} skipped.`;
        this.sendReport(peer, message);
        this.log.info(`${message} World ${job.level}, center ${job.centerX}, ${job.centerZ}, radius ${job.radius}.`);
        this.job = undefined;
    }

    private completed(job: ForcedJob): number {
        return job.built + this.skipped(job);
    }

    private skipped(job: ForcedJob): number {
        return job.skipped + job.skippedOutsideBorder;
    }

    private sendReport(peer: ForcedLodPeer, message: string): void {
        try {
            peer.report(message);
        } catch (err) {
            this.log.warn(`Could not report forced LOD progress to ${peer.name}: ${String(err)}`);
        }
    }
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
