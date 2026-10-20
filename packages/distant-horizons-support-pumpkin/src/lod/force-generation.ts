import { ansi } from '@pumpkin-plugins/minecraft-colors';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { AdaptiveWorkBudget, type TerrainAccess, type TerrainRegion } from '@pumpkin-plugins/terrain';
import { SECTION_SIZE_BLOCKS } from '../protocol/constants.ts';
import { encodeSection } from '../protocol/messages.ts';
import { LodBuilder } from './builder.ts';
import type { CacheRecoveryBackup, LodCache } from './cache.ts';
import {
    iterateLodSectionsWithin,
    type LodSectionBounds,
    type LodSectionCoordinate,
    lodGenerationSectionCount,
    MAX_LOD_GENERATION_SECTIONS,
    sectionKey,
    sectionRegion,
} from './generation.ts';
import { lodLocation } from './location.ts';

/** Maximum block samples a forced capture attempts in one server tick; MSPT and sample cost lower it. */
export const FORCE_BLOCK_SAMPLES_PER_TICK = 32_768;

/** Terrain and reporting access valid only for the duration of a peer callback. */
export interface ForcedLodPeer {
    /** Inclusive block-center bounds of the world border. */
    borderBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
    insideBorder(x: number, z: number): boolean;
    level: string;
    name: string;
    report(message: string): void;
    terrain: TerrainAccess;
}

/** Obtains a fresh player and world handle for a forced-capture tick; returns false when the player is gone. */
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
/** One selected cached section exported safely before an operator recovery job. */
export interface ForcedLodRecovery {
    backup: CacheRecoveryBackup;
    start: ForcedLodStart;
}

interface ForcedSection {
    builder?: LodBuilder;
    coordinate: LodSectionCoordinate;
    invalidated: boolean;
    key: string;
}

interface ForcedJob extends ForcedLodStart {
    built: number;
    coordinates: Generator<LodSectionCoordinate>;
    current?: ForcedSection;
    inBorderSections: number;
    lastReportedStep: number;
    level: string;
    owner: string;
    scanned: number;
    skipped: number;
    skippedAlreadyGenerated: number;
    skippedOutsideBorder: number;
}

const MAX_SECTIONS_CHECKED_PER_TICK = 64;
// Terrain checks call the host synchronously; cap them separately from cache and border scans.
const MAX_TERRAIN_PREPARATIONS_PER_TICK = 8;

/** Captures operator-requested sections with spare tick time, without retaining Pumpkin handles. */
export class ForcedLodGeneration {
    private job?: ForcedJob;
    private readonly workBudget = new AdaptiveWorkBudget({ initialUnits: FORCE_BLOCK_SAMPLES_PER_TICK });

    constructor(
        private readonly cache: LodCache,
        private readonly log: Logger,
        private readonly now = Date.now,
        private readonly measureNow = Date.now,
    ) {}

    /** Starts one bounded, cache-refreshing job around the selected block position. */
    start(peer: ForcedLodPeer, blockX: number, blockZ: number, radius = 0): ForcedLodStart {
        if (this.job) throw new Error('A forced LOD generation job is already running.');
        const sections = lodGenerationSectionCount(radius);
        if (!Number.isSafeInteger(blockX) || !Number.isSafeInteger(blockZ)) {
            throw new RangeError('Block coordinates must be safe integers.');
        }
        const { memoryLimit, diskLimit } = this.cache.stats();
        if (memoryLimit === 0 && diskLimit === 0) throw new Error('Both LOD cache tiers are disabled.');

        const selection = this.validateSelection(peer, blockX, blockZ, radius);
        return this.begin(peer, blockX, blockZ, radius, { ...selection, sections });
    }

    /** Backs up, removes and rebuilds one explicitly selected cached LOD section. */
    recover(peer: ForcedLodPeer, blockX: number, blockZ: number): ForcedLodRecovery {
        if (this.job) throw new Error('A forced LOD generation job is already running.');
        if (!Number.isSafeInteger(blockX) || !Number.isSafeInteger(blockZ)) {
            throw new RangeError('Block coordinates must be safe integers.');
        }
        const sections = lodGenerationSectionCount(0);
        const { memoryLimit, diskLimit } = this.cache.stats();
        if (memoryLimit === 0 && diskLimit === 0) throw new Error('Both LOD cache tiers are disabled.');

        const centerX = Math.floor(blockX / SECTION_SIZE_BLOCKS);
        const centerZ = Math.floor(blockZ / SECTION_SIZE_BLOCKS);
        const key = sectionKey(peer.level, centerX, centerZ);
        if (!this.cache.has(key)) throw new Error('No cached LOD section exists at the selected coordinates.');
        const selection = this.validateSelection(peer, blockX, blockZ, 0);
        const prepared = peer.terrain.prepare?.(sectionRegion({ x: centerX, z: centerZ }, peer.terrain));
        if (prepared?.status !== 'ready') {
            const reason = prepared && 'reason' in prepared ? ` ${prepared.reason}` : '';
            throw new Error(
                `Cache recovery deferred until all section chunks are loaded; the selected cache entry is preserved.${reason}`,
            );
        }

        const backup = this.cache.backupAndRemove(key);
        if (!backup) throw new Error('Selected cache entry could not be backed up; it was preserved.');
        return { start: this.begin(peer, blockX, blockZ, 0, { ...selection, sections }), backup };
    }

    private begin(
        peer: ForcedLodPeer,
        blockX: number,
        blockZ: number,
        radius: number,
        selection: { bounds: LodSectionBounds; inBorderSections: number; sections: number },
    ): ForcedLodStart {
        const centerX = Math.floor(blockX / SECTION_SIZE_BLOCKS);
        const centerZ = Math.floor(blockZ / SECTION_SIZE_BLOCKS);
        const { sections } = selection;

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
            lastReportedStep: 0,
        };
        this.log.info(
            `Started forced LOD capture for ${ansi.named.name(peer.name)}: ${ansi.named.number(sections)} requested sections in ${ansi.named.identifier(peer.level)}.`,
        );
        return { centerX, centerZ, radius, sections };
    }

    /** Advances the active job within the server's spare tick time, returning true when this tick was reserved for forced work. */
    tick(peers: ForcedLodPeers, serverMspt = 0): boolean {
        const job = this.job;
        if (!job) return false;

        let found: boolean;
        try {
            found = peers.withPeer(job.owner, (peer) => {
                if (peer.level !== job.level) {
                    this.sendReport(peer, 'Forced LOD capture cancelled because you changed worlds.');
                    this.job = undefined;
                    return;
                }
                this.advance(job, peer, serverMspt);
            });
        } catch (err) {
            this.log.warn(
                `Cancelled forced LOD capture for ${ansi.named.name(job.owner)} after an error: ${String(err)}.`,
            );
            if (this.job === job) this.job = undefined;
            return true;
        }
        if (!found && this.job === job) {
            this.log.info(
                `Cancelled forced LOD capture for ${ansi.named.name(job.owner)}: player is no longer available.`,
            );
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
                `Invalidated forced LOD for ${ansi.named.name(job.owner)} at ${lodLocation(level, target.coordinate.x, target.coordinate.z)} after a block change.`,
            );
        }
    }

    /** Cancels an owner's job when they disconnect. */
    left(name: string): void {
        if (this.job?.owner !== name) return;
        this.job = undefined;
        this.log.info(`Cancelled forced LOD capture for ${ansi.named.name(name)}: player disconnected.`);
    }

    private advance(job: ForcedJob, peer: ForcedLodPeer, serverMspt: number): void {
        let budget = this.workBudget.next(serverMspt, FORCE_BLOCK_SAMPLES_PER_TICK);
        let sectionsChecked = 0;
        let terrainPreparations = 0;
        const prepareTerrain = (region: TerrainRegion) => {
            if (!peer.terrain.prepare) return undefined;
            if (terrainPreparations >= MAX_TERRAIN_PREPARATIONS_PER_TICK) return { status: 'pending' as const };
            terrainPreparations++;
            return peer.terrain.prepare(region);
        };

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
                target = { coordinate, key, invalidated: false };
                job.current = target;
                // Validate cache blobs within the existing per-tick section budget, never during admission.
                // A failed read skips only this section; escaping here would end the whole job.
                try {
                    if (this.cache.get(key)) {
                        job.skippedAlreadyGenerated++;
                        job.current = undefined;
                        continue;
                    }
                } catch (err) {
                    this.skip(job, String(err));
                    continue;
                }
            }
            if (target.invalidated) {
                this.log.debug(
                    `Skipped invalidated forced LOD for ${ansi.named.name(job.owner)} at ${lodLocation(job.level, target.coordinate.x, target.coordinate.z)}.`,
                );
                job.skipped++;
                job.current = undefined;
                continue;
            }
            if (budget === 0) break;

            try {
                const region = sectionRegion(target.coordinate, peer.terrain);
                const prepared = prepareTerrain(region);
                if (prepared?.status === 'pending') break;
                if (prepared && prepared.status !== 'ready') {
                    this.skip(job, prepared.reason);
                    continue;
                }

                target.builder ??= new LodBuilder(
                    encodeSection(target.coordinate.x, target.coordinate.z),
                    region.minY,
                    region.height,
                );
                const sampledBefore = target.builder.samples();
                const started = this.measureNow();
                const complete = target.builder.step(peer.terrain, budget);
                const sampled = target.builder.samples() - sampledBefore;
                this.workBudget.observe(sampled, this.measureNow() - started);
                budget -= sampled;
                if (!complete) break;

                const stillPrepared = prepareTerrain(region);
                if (stillPrepared?.status === 'pending') break;
                if (stillPrepared && stillPrepared.status !== 'ready') {
                    this.skip(job, stillPrepared.reason);
                    continue;
                }

                const data = target.builder.finish(this.now());
                this.cache.put(target.key, { updated: this.now(), data });
                this.log.debug(
                    `Built forced LOD for ${ansi.named.name(peer.name)} at ${lodLocation(job.level, target.coordinate.x, target.coordinate.z)} (${ansi.named.number(data.length)} bytes).`,
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

    private skip(job: ForcedJob, reason: string): void {
        const target = job.current;
        job.skipped++;
        job.current = undefined;
        if (target) {
            this.log.debug(
                `Skipped forced LOD for ${ansi.named.name(job.owner)} at ${lodLocation(job.level, target.coordinate.x, target.coordinate.z)}: ${reason}.`,
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
            `Forced LOD capture ${step * 10}% (${this.completed(job)}/${job.sections} sections complete).`,
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
                this.log.info(`${message} ${this.jobSummary(job)}`);
                this.job = undefined;
                return;
            }
        }
        const skipped = this.skipped(job);
        const message = `Forced LOD capture complete: ${job.built} built, ${skipped} skipped (${job.skippedAlreadyGenerated} already generated).`;
        this.sendReport(peer, message);
        this.log.info(`${message} ${this.jobSummary(job)}`);
        this.job = undefined;
    }

    private jobSummary(job: ForcedJob): string {
        return `Player ${ansi.named.name(job.owner)}, world ${ansi.named.identifier(job.level)}, center ${ansi.named.number(job.centerX)}, ${ansi.named.number(job.centerZ)}, radius ${ansi.named.number(job.radius)}.`;
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
    ): { bounds: LodSectionBounds; inBorderSections: number } {
        const centerX = Math.floor(blockX / SECTION_SIZE_BLOCKS);
        const centerZ = Math.floor(blockZ / SECTION_SIZE_BLOCKS);
        const bounds = peer.borderBounds;
        const minX = Math.max(centerX - radius, Math.ceil((bounds.minX - 0.5) / SECTION_SIZE_BLOCKS));
        const maxX = Math.min(
            centerX + radius,
            Math.floor((bounds.maxX - SECTION_SIZE_BLOCKS + 0.5) / SECTION_SIZE_BLOCKS),
        );
        const minZ = Math.max(centerZ - radius, Math.ceil((bounds.minZ - 0.5) / SECTION_SIZE_BLOCKS));
        const maxZ = Math.min(
            centerZ + radius,
            Math.floor((bounds.maxZ - SECTION_SIZE_BLOCKS + 0.5) / SECTION_SIZE_BLOCKS),
        );
        if (minX > maxX || minZ > maxZ) throw new Error('No requested LOD sections are inside the world border.');

        const width = maxX - minX + 1;
        const depth = maxZ - minZ + 1;
        if (width > Math.floor(MAX_LOD_GENERATION_SECTIONS / depth)) {
            throw new RangeError('Selected LOD sections exceed the forced-generation work limit.');
        }
        const inBorderSections = width * depth;
        return { bounds: { minX, maxX, minZ, maxZ }, inBorderSections };
    }

    private sendReport(peer: ForcedLodPeer, message: string): void {
        try {
            peer.report(message);
        } catch (err) {
            this.log.warn(`Could not report forced LOD progress to ${ansi.named.name(peer.name)}: ${String(err)}`);
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
