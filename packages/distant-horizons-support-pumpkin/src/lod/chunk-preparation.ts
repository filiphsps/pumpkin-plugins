import { ansi } from '@pumpkin-plugins/minecraft-colors';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import {
    type BridgeRejection,
    type CallResult,
    type JobState,
    LIMITS,
    type ProviderFailure,
    type ProviderState,
    type PumpkinPlusPlusSession,
} from '@pumpkin-plugins/pumpkin-plus-plus-api';
import type { TerrainPreparationResult, TerrainRegion } from '@pumpkin-plugins/terrain';
import { chunkBounds, iterateChunkCoordinates } from '../chunk-coordinates.ts';
import { PLUGIN_NAME } from '../name.ts';
import { CHUNK_SIZE_BLOCKS, SECTION_SIZE_BLOCKS } from '../protocol/constants.ts';

const logTag = ansi.named.name(PLUGIN_NAME);

interface ChunkJob {
    expiresAt?: number;
    leaseId?: string;
    operationDeadline?: number;
    operationId?: string;
    retryAfterTick?: number;
    readonly x: number;
    readonly z: number;
}

interface CapturePreparation {
    accepted: boolean;
    readonly chunks: ChunkJob[];
    failure?: string;
    uncertainSubmitUntil?: number;
    readonly world: string;
}

const MAX_CHUNK_JOBS_PER_SECTION = (SECTION_SIZE_BLOCKS / CHUNK_SIZE_BLOCKS) ** 2;

/** Coordinates bounded Pumpkin++ chunk jobs while retaining only scalar identities across ticks. */
export class ChunkPreparation {
    private readonly captures = new Map<string, CapturePreparation>();
    private readonly localFallback = new Set<string>();
    private tickNumber = 0;
    private callsThisTick = 0;
    private callsPerTick = 0;

    /** Creates the provider coordinator without opening host resources or probing IPC. */
    constructor(
        private readonly provider: PumpkinPlusPlusSession | undefined,
        private readonly now: () => number,
        private readonly log: Logger,
    ) {}

    /** Reports whether this coordinator can request chunks from the native host. */
    hasProvider(): boolean {
        return this.provider !== undefined;
    }

    /** Reserves this tick's provider-call budget and advances previously admitted jobs. */
    beginTick(callsPerTick: number): void {
        this.tickNumber++;
        this.callsThisTick = 0;
        this.callsPerTick = Math.max(0, Math.floor(callsPerTick));
        this.pollPending();
    }

    /** Prepares every chunk covered by one LOD region, retaining ready leases until cleanup. */
    prepare(
        captureId: string,
        world: string,
        region: TerrainRegion,
        local: TerrainPreparationResult | undefined,
    ): TerrainPreparationResult {
        if (!this.provider) return local ?? { status: 'ready' };
        if (this.localFallback.has(captureId)) return local ?? { status: 'ready' };

        let capture = this.captures.get(captureId);
        if (!capture) {
            const chunks = this.chunks(region);
            if (!chunks) return { status: 'unavailable', reason: 'LOD region exceeds the chunk preparation limit' };
            capture = { world, chunks, accepted: false };
            this.captures.set(captureId, capture);
        } else if (capture.world !== world) {
            this.fail(capture, 'LOD world changed during chunk preparation');
        }

        if (capture.failure) return this.failureResult(capture, captureId, local);
        this.submitPending(capture);
        if (capture.failure) return this.failureResult(capture, captureId, local);

        if (capture.chunks.every((chunk) => chunk.leaseId !== undefined)) {
            if (capture.chunks.some((chunk) => (chunk.expiresAt ?? 0) <= this.now())) {
                const reason = 'Pumpkin++ chunk lease expired during LOD capture';
                this.fail(capture, reason);
                return { status: 'unavailable', reason };
            }
            if (local && local.status !== 'ready') return { status: 'pending' };
            return { status: 'ready' };
        }
        return { status: 'pending' };
    }

    /** Cancels pending jobs and releases ready leases for one abandoned capture. */
    abandon(captureId: string): void {
        this.localFallback.delete(captureId);
        const capture = this.captures.get(captureId);
        if (!capture) return;
        this.cleanup(capture);
        this.captures.delete(captureId);
    }

    /** Retains an uncertain submit until native expiry and returns the earliest safe retry time. */
    defer(captureId: string): number | undefined {
        const capture = this.captures.get(captureId);
        if (capture?.uncertainSubmitUntil !== undefined && this.now() < capture.uncertainSubmitUntil)
            return capture.uncertainSubmitUntil;
        this.abandon(captureId);
        return undefined;
    }

    /** Drops local capture state; the provider reaps jobs after this plugin becomes inactive. */
    dispose(): void {
        this.captures.clear();
        this.localFallback.clear();
    }

    /** Refreshes the provider observation for an explicit operator status check. */
    availability(): ProviderState {
        if (!this.provider) return { kind: 'missing' };
        try {
            return this.provider.availability();
        } catch (error) {
            this.log.debug(`${logTag} Pumpkin++ availability check failed: ${ansi.named.error(String(error))}`);
            return { kind: 'temporarily_unreachable' };
        }
    }

    /** Reports whether this capture still needs provider jobs to make progress. */
    isPreparing(captureId: string): boolean {
        return this.captures.has(captureId);
    }

    private pollPending(): void {
        this.expireOverdueOperations();
        if (!this.provider) return;
        for (const capture of this.captures.values()) {
            if (capture.failure) continue;
            for (const chunk of capture.chunks) {
                if (!chunk.operationId || chunk.leaseId || (chunk.retryAfterTick ?? 0) > this.tickNumber) continue;
                if (!this.takeCall()) return;
                const startedAt = this.now();
                let result: CallResult<JobState>;
                try {
                    result = this.provider.poll(chunk.operationId);
                } catch (error) {
                    this.fail(capture, String(error));
                    break;
                }
                if (!result.ok) {
                    if (this.isTransient(result.error)) {
                        chunk.retryAfterTick = this.tickNumber + 1;
                        continue;
                    }
                    if ('code' in result.error && result.error.operationId === chunk.operationId)
                        chunk.operationId = undefined;
                    this.fail(capture, this.errorMessage(result.error));
                    break;
                }
                this.accept(chunk, result.value, startedAt);
            }
        }
    }

    private submitPending(capture: CapturePreparation): void {
        if (!this.provider) return;
        for (const chunk of capture.chunks) {
            if (chunk.operationId || chunk.leaseId || (chunk.retryAfterTick ?? 0) > this.tickNumber) continue;
            if (!this.takeCall()) return;
            const startedAt = this.now();
            let result: CallResult<JobState>;
            try {
                result = this.provider.submit({ world: capture.world, x: chunk.x, z: chunk.z });
            } catch (error) {
                this.fail(capture, String(error));
                return;
            }
            if (!result.ok) {
                if ('code' in result.error && result.error.code === 'busy') {
                    chunk.retryAfterTick = this.tickNumber + 1;
                    return;
                }
                if ('status' in result.error && result.error.phase === 'probe') {
                    this.fail(capture, this.errorMessage(result.error));
                    return;
                }
                if ('status' in result.error && result.error.kind === 'temporarily_unreachable')
                    capture.uncertainSubmitUntil = this.now() + LIMITS.maxJobDeadlineMs;
                this.fail(capture, this.errorMessage(result.error));
                return;
            }
            capture.accepted = true;
            this.accept(chunk, result.value, startedAt);
        }
    }

    private accept(chunk: ChunkJob, job: JobState, startedAt: number): void {
        if (chunk.operationId !== job.operationId) chunk.operationDeadline = startedAt + LIMITS.maxJobDeadlineMs;
        chunk.operationId = job.operationId;
        if (job.state !== 'ready') return;
        chunk.leaseId = job.leaseId;
        chunk.expiresAt = startedAt + job.remainingLeaseMs;
        chunk.operationDeadline = undefined;
    }

    private expireOverdueOperations(): void {
        const now = this.now();
        for (const capture of this.captures.values()) {
            if (
                !capture.failure &&
                capture.chunks.some(
                    (chunk) =>
                        chunk.operationId !== undefined &&
                        chunk.leaseId === undefined &&
                        chunk.operationDeadline !== undefined &&
                        chunk.operationDeadline <= now,
                )
            ) {
                this.fail(capture, 'Pumpkin++ chunk operation exceeded native job deadline');
            }
        }
    }

    private failureResult(
        capture: CapturePreparation,
        captureId: string,
        local: TerrainPreparationResult | undefined,
    ): TerrainPreparationResult {
        const reason = capture.failure ?? 'Pumpkin++ chunk preparation failed';
        if ((!capture.accepted || capture.uncertainSubmitUntil !== undefined) && local?.status === 'ready') {
            this.captures.delete(captureId);
            this.localFallback.add(captureId);
            return { status: 'ready' };
        }
        return { status: 'unavailable', reason };
    }

    private fail(capture: CapturePreparation, reason: string): void {
        capture.failure = reason;
        this.cleanup(capture);
        this.log.debug(
            `${logTag} LOD preparation failed for ${ansi.named.identifier(capture.world)}: ${ansi.named.error(reason)}.`,
        );
    }

    private cleanup(capture: CapturePreparation): void {
        for (const chunk of capture.chunks) {
            if (chunk.leaseId) {
                this.releaseLease(chunk.leaseId);
                chunk.leaseId = undefined;
            } else if (chunk.operationId) {
                try {
                    const result = this.provider?.cancel(chunk.operationId);
                    if (result && !result.ok)
                        this.log.debug(
                            `${logTag} Could not cancel Pumpkin++ job: ${ansi.named.error(this.errorMessage(result.error))}.`,
                        );
                    else if (result?.ok && result.value.state === 'ready') this.releaseLease(result.value.leaseId);
                } catch (error) {
                    this.log.debug(`${logTag} Could not cancel Pumpkin++ job: ${ansi.named.error(String(error))}.`);
                }
            }
            chunk.operationId = undefined;
            chunk.operationDeadline = undefined;
        }
    }

    private releaseLease(leaseId: string): void {
        try {
            const result = this.provider?.release(leaseId);
            if (result && !result.ok)
                this.log.debug(
                    `${logTag} Could not release Pumpkin++ lease: ${ansi.named.error(this.errorMessage(result.error))}.`,
                );
        } catch (error) {
            this.log.debug(`${logTag} Could not release Pumpkin++ lease: ${ansi.named.error(String(error))}.`);
        }
    }

    private chunks(region: TerrainRegion): ChunkJob[] | undefined {
        const bounds = chunkBounds(region);
        const count = (bounds.lastX - bounds.firstX + 1) * (bounds.lastZ - bounds.firstZ + 1);
        if (count < 1 || count > MAX_CHUNK_JOBS_PER_SECTION) return undefined;
        const chunks: ChunkJob[] = [];
        for (const { x, z } of iterateChunkCoordinates(bounds)) chunks.push({ x, z });
        return chunks;
    }

    private takeCall(): boolean {
        if (this.callsThisTick >= this.callsPerTick) return false;
        this.callsThisTick++;
        return true;
    }

    private isTransient(error: ProviderFailure | BridgeRejection): boolean {
        return 'status' in error ? error.kind === 'temporarily_unreachable' : error.code === 'busy';
    }

    private errorMessage(error: ProviderFailure | BridgeRejection): string {
        if ('status' in error) return error.kind.replaceAll('_', ' ');
        return error.message ? `${error.code}: ${error.message}` : error.code.replaceAll('_', ' ');
    }
}
