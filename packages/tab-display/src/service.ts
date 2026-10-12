import type { ResolvedLine, SessionState } from '@pumpkin-plugins/pumpkin-pie-api';
import { strToU8 } from 'fflate';
import { type ConfigValidation, type TabDisplayConfig, type TemplateLineConfig, validateConfig } from './config.ts';
import {
    type ApplyResult,
    type Capability,
    JAVA_DISPLAY_VERSION,
    type PlayerSnapshot,
    type RenderedLine,
    type TabDisplayStatus
} from './model.ts';
import { assignDenseOrders } from './sorting.ts';
import { type CompiledTemplate, compileTemplate, renderTemplate } from './templates.ts';

/** One request sent to the shared PumpkinPIE client. */
export interface PlaceholderRequest {
    readonly text: string;
    readonly viewer?: string;
}

/** Host-independent subset of the shared PumpkinPIE client used by the scheduler. */
export interface TabPlaceholderResolver {
    readonly state?: SessionState;
    resolveBatch(requests: readonly PlaceholderRequest[]): readonly ResolvedLine[];
}

/** Host calls required by the pure service; adapters copy and dispose WASI resources themselves. */
export interface TabDisplayHost {
    /** Copies bounded player primitives from the host. */
    snapshotPlayers(limit: number): readonly PlayerSnapshot[];
    /** Applies a global subject row name. Undefined clears the custom name. */
    setEntryName(uuid: string, value: RenderedLine | undefined): ApplyResult;
    /** Applies one dense native player-list order. */
    setOrder(uuid: string, order: number): ApplyResult;
    /** Applies a personalized viewer header and footer. */
    setHeaderFooter(uuid: string, header: readonly RenderedLine[], footer: readonly RenderedLine[]): ApplyResult;
    /** Restores only fields currently owned by this plugin. */
    resetOwned(uuid: string): void;
}

/** Dependencies of the host-independent display service. */
export interface TabDisplayServiceOptions {
    readonly host: TabDisplayHost;
    readonly resolver: TabPlaceholderResolver;
    readonly now: () => number;
    readonly config: TabDisplayConfig;
    readonly sortingCapability?: Capability;
    readonly log?: (message: string) => void;
}

/** Maximum placeholder jobs resolved on a single game tick. */
export const MAX_JOBS_PER_TICK = 256;
/** Maximum time a previous placeholder frame is retained during provider outages. */
export const STALE_FRAME_MS = 30_000;

interface RenderTarget {
    readonly template: CompiledTemplate;
    readonly style: Omit<RenderedLine, 'text'>;
}

interface PreparedPlayer {
    readonly snapshot: PlayerSnapshot;
    readonly entry?: RenderTarget;
    readonly header: readonly RenderTarget[];
    readonly footer: readonly RenderTarget[];
}

interface PlaceholderJob {
    readonly key: string;
    readonly request: PlaceholderRequest;
}

interface PendingGeneration {
    readonly players: readonly PreparedPlayer[];
    readonly jobs: readonly PlaceholderJob[];
    readonly results: Map<string, ResolvedLine>;
    cursor: number;
}

/** Bounded, changed-only display reconciliation with a host-free test boundary. */
export class TabDisplayService {
    private config: TabDisplayConfig;
    private pending: PendingGeneration | undefined;
    private tickNumber = 0;
    private nextRefreshTick = 0;
    private lastSuccessfulAt: number | undefined;
    private lastFailure: string | undefined;
    private unresolved = new Set<string>();
    private previousOnline = new Set<string>();
    private readonly appliedNames = new Map<string, string | undefined>();
    private readonly appliedOrders = new Map<string, number>();
    private readonly appliedHeaders = new Map<string, string>();
    private latestPlayers: readonly PlayerSnapshot[] = [];
    private disabled = false;

    /** Creates the service from a validated config snapshot. */
    constructor(private readonly options: TabDisplayServiceOptions) {
        const checked = validateConfig(options.config);
        if (checked.kind !== 'valid') throw new Error(formatIssues(checked));
        this.config = checked.config;
    }

    /** Validates the whole replacement before atomically swapping configuration. */
    setConfig(value: unknown): ApplyResult {
        const checked = validateConfig(value);
        if (checked.kind === 'invalid') return { kind: 'failed', error: formatIssues(checked) };
        this.config = checked.config;
        this.pending = undefined;
        this.nextRefreshTick = this.tickNumber;
        this.lastFailure = undefined;
        return { kind: 'applied' };
    }

    /** Returns one copied online snapshot and configured placeholder IDs, never resolved values. */
    inspect(uuid: string): (PlayerSnapshot & { readonly placeholderIds: readonly string[] }) | undefined {
        const snapshot = this.latestPlayers.find((player) => player.uuid === uuid);
        if (snapshot === undefined) return undefined;
        const sources = [
            ...(snapshot.edition === 'java' && this.config.entry.enabled ? [this.config.entry.text] : []),
            ...(snapshot.edition === 'java' ? this.config.header.lines.map(({ text }) => text) : []),
            ...(snapshot.edition === 'java' ? this.config.footer.lines.map(({ text }) => text) : [])
        ];
        const placeholderIds = [...new Set(sources.flatMap((source) => compileTemplate(source).placeholderIds))].sort();
        return { ...copySnapshot(snapshot), placeholderIds };
    }

    /** Advances bounded placeholder work and commits only complete display generations. */
    tick(): void {
        this.tickNumber += 1;
        let snapshots: readonly PlayerSnapshot[];
        try {
            snapshots = this.options.host.snapshotPlayers(this.config.general.max_players);
        } catch {
            this.lastFailure = 'Could not read the current player snapshot';
            return;
        }
        if (snapshots.length > this.config.general.max_players) {
            this.pending = undefined;
            this.lastFailure = `Online player count exceeds general.max_players (${this.config.general.max_players})`;
            return;
        }
        this.latestPlayers = snapshots.map(copySnapshot);

        if (!this.config.general.enabled) {
            if (!this.disabled) {
                for (const player of this.latestPlayers) this.safeReset(player.uuid);
                this.clearApplied();
                this.disabled = true;
            }
            this.pending = undefined;
            this.previousOnline = new Set(this.latestPlayers.map(({ uuid }) => uuid));
            return;
        }
        this.disabled = false;
        this.resetDisconnected(this.latestPlayers);

        const now = this.readClock();
        if (now === undefined) return;
        if (
            !this.providerAvailable() &&
            this.lastSuccessfulAt !== undefined &&
            now - this.lastSuccessfulAt < STALE_FRAME_MS
        ) {
            this.pending = undefined;
            this.nextRefreshTick = this.tickNumber + this.config.general.refresh_ticks;
            return;
        }

        if (this.pending === undefined) {
            if (this.tickNumber < this.nextRefreshTick) return;
            this.pending = this.prepareGeneration(this.latestPlayers);
            this.nextRefreshTick = this.tickNumber + this.config.general.refresh_ticks;
        }
        this.processGeneration(now);
    }

    /** Restores plugin-owned changes for online players before unload. */
    shutdown(): void {
        for (const player of this.latestPlayers) this.safeReset(player.uuid);
        this.pending = undefined;
        this.clearApplied();
        this.previousOnline.clear();
    }

    /** Reports safe runtime state without resolved placeholder values or player names. */
    status(): TabDisplayStatus {
        const state = this.options.resolver.state;
        const javaPlayers = this.latestPlayers.filter(({ edition }) => edition === 'java').length;
        const bedrockPlayers = this.latestPlayers.filter(({ edition }) => edition === 'bedrock').length;
        const javaVersions = [
            ...new Set(this.latestPlayers.flatMap(({ javaVersion }) => (javaVersion ? [javaVersion] : [])))
        ].sort();
        const unsupportedJavaVersions = [
            ...new Set(
                this.latestPlayers
                    .filter(({ edition, javaVersion }) => edition === 'java' && javaVersion !== JAVA_DISPLAY_VERSION)
                    .map(({ javaVersion }) => javaVersion ?? 'unknown')
            )
        ].sort();
        return {
            enabled: this.config.general.enabled,
            provider: state?.kind ?? 'ready',
            players: this.latestPlayers.length,
            javaPlayers,
            bedrockPlayers,
            pendingJobs: this.pending?.jobs.length ?? 0,
            unresolved: [...this.unresolved].sort(),
            javaVersions,
            ...(this.lastFailure === undefined ? {} : { lastFailure: this.lastFailure }),
            java:
                unsupportedJavaVersions.length > 0
                    ? {
                          kind: 'unsupported',
                          reason: `Java tab display calls are gated to ${JAVA_DISPLAY_VERSION}; live client behavior is unverified (connected: ${unsupportedJavaVersions.join(', ')})`
                      }
                    : { kind: 'supported' },
            bedrock: {
                kind: 'unsupported',
                reason: 'TabDisplay leaves the native Bedrock player list unchanged.'
            },
            sorting: this.options.sortingCapability ?? {
                kind: 'unsupported',
                reason: 'Native Java tab order direction is not verified on a client.'
            }
        };
    }

    private prepareGeneration(players: readonly PlayerSnapshot[]): PendingGeneration {
        const prepared = players.map((snapshot) => ({
            snapshot,
            ...(this.config.entry.enabled
                ? {
                      entry: makeTarget({
                          text: this.config.entry.text,
                          color: this.config.entry.color,
                          bold: this.config.entry.bold,
                          italic: this.config.entry.italic,
                          underlined: this.config.entry.underlined,
                          strikethrough: this.config.entry.strikethrough
                      })
                  }
                : {}),
            header: snapshot.edition === 'java' ? this.config.header.lines.map(makeTarget) : [],
            footer: snapshot.edition === 'java' ? this.config.footer.lines.map(makeTarget) : []
        }));

        const jobs = new Map<string, PlaceholderJob>();
        for (const player of prepared) {
            for (const target of targetsOf(player)) {
                if (!target.template.hasPlaceholders) continue;
                const key = jobKey(player.snapshot, target.template.source);
                jobs.set(key, {
                    key,
                    request: { text: target.template.source, viewer: player.snapshot.name }
                });
            }
        }
        return { players: prepared, jobs: [...jobs.values()], results: new Map(), cursor: 0 };
    }

    private processGeneration(now: number): void {
        const generation = this.pending;
        if (generation === undefined) return;

        if (generation.jobs.length > 0 && this.providerAvailable()) {
            const chunk = fitBatch(generation.jobs, generation.cursor, MAX_JOBS_PER_TICK);
            if (chunk.length === 0) {
                this.failGeneration(generation, now, 'Placeholder batch exceeded the PumpkinPIE request limit');
                return;
            }
            try {
                const resolved = this.options.resolver.resolveBatch(chunk.map(({ request }) => request));
                if (resolved.length !== chunk.length) {
                    this.failGeneration(generation, now, 'Placeholder batch count did not match request count');
                    return;
                }
                for (const [index, result] of resolved.entries()) {
                    const job = chunk[index];
                    if (job === undefined) {
                        this.failGeneration(generation, now, 'Placeholder batch count did not match request count');
                        return;
                    }
                    generation.results.set(job.key, result);
                }
                generation.cursor += chunk.length;
            } catch {
                this.failGeneration(generation, now, 'Placeholder resolution failed');
                return;
            }
        } else if (generation.jobs.length > 0) {
            generation.cursor = generation.jobs.length;
        }

        if (generation.cursor < generation.jobs.length) return;
        const providerAvailable = this.providerAvailable() && generation.jobs.length > 0;
        let phase: 'rendering' | 'updating' = 'rendering';
        try {
            const unresolved = new Set<string>();
            const rendered = generation.players.map((player) => {
                const render = (target: RenderTarget): RenderedLine => {
                    const resolution = target.template.hasPlaceholders
                        ? generation.results.get(jobKey(player.snapshot, target.template.source))
                        : undefined;
                    if (resolution) for (const id of resolution.unresolved) unresolved.add(id);
                    const policy = providerAvailable
                        ? fallback(this.config.placeholders.unresolved)
                        : fallback(this.config.placeholders.missing_provider);
                    return {
                        text: renderTemplate(target.template, resolution, policy, providerAvailable),
                        ...target.style
                    };
                };
                return {
                    snapshot: player.snapshot,
                    entry: player.entry === undefined ? undefined : render(player.entry),
                    header: player.header.map(render),
                    footer: player.footer.map(render)
                };
            });
            if (providerAvailable) this.lastSuccessfulAt = now;
            this.unresolved = unresolved;
            phase = 'updating';
            this.applyGeneration(generation.players, rendered);
            this.pending = undefined;
            this.lastFailure = undefined;
        } catch (error) {
            const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            const reason =
                phase === 'updating' ? `Display update failed: ${detail}` : `Rendered display failed: ${detail}`;
            this.failGeneration(generation, now, reason);
        }
    }

    private failGeneration(generation: PendingGeneration, now: number, reason: string): void {
        this.pending = undefined;
        this.lastFailure = reason;
        if (this.options.log) this.options.log(reason);
        if (this.lastSuccessfulAt !== undefined && now - this.lastSuccessfulAt < STALE_FRAME_MS) return;

        try {
            const rendered = generation.players.map((player) => ({
                snapshot: player.snapshot,
                entry: player.entry === undefined ? undefined : renderTemplateFallback(player.entry, this.config),
                header: player.header.map((target) => renderTemplateFallback(target, this.config)),
                footer: player.footer.map((target) => renderTemplateFallback(target, this.config))
            }));
            this.applyGeneration(generation.players, rendered);
        } catch {
            this.lastFailure = 'Literal fallback exceeded the configured output limits';
        }
    }

    private applyGeneration(
        prepared: readonly PreparedPlayer[],
        rendered: readonly {
            readonly snapshot: PlayerSnapshot;
            readonly entry: RenderedLine | undefined;
            readonly header: readonly RenderedLine[];
            readonly footer: readonly RenderedLine[];
        }[]
    ): void {
        const snapshots = prepared.map(({ snapshot }) => snapshot);
        const orderByUuid =
            this.config.sorting.rules.length === 0
                ? new Map<string, number>()
                : new Map(
                      assignDenseOrders(snapshots, this.config.sorting.rules).map(({ uuid, order }) => [uuid, order])
                  );

        for (const item of rendered) {
            const { snapshot } = item;
            if (snapshot.edition === 'java' && item.entry !== undefined) this.applyName(snapshot.uuid, item.entry);
            else if (snapshot.edition === 'java' && this.appliedNames.has(snapshot.uuid))
                this.applyName(snapshot.uuid, undefined);
            if (this.config.sorting.rules.length > 0) {
                const order = orderByUuid.get(snapshot.uuid) ?? 0;
                if (this.appliedOrders.get(snapshot.uuid) !== order) {
                    this.recordApply(this.options.host.setOrder(snapshot.uuid, order));
                    this.appliedOrders.set(snapshot.uuid, order);
                }
            } else if (this.appliedOrders.has(snapshot.uuid)) {
                this.recordApply(this.options.host.setOrder(snapshot.uuid, 0));
                this.appliedOrders.delete(snapshot.uuid);
            }
            if (snapshot.edition === 'java') {
                const key = JSON.stringify([item.header, item.footer]);
                if (this.appliedHeaders.get(snapshot.uuid) !== key) {
                    this.recordApply(this.options.host.setHeaderFooter(snapshot.uuid, item.header, item.footer));
                    this.appliedHeaders.set(snapshot.uuid, key);
                }
            }
        }
    }

    private applyName(uuid: string, value: RenderedLine | undefined): void {
        const key = value === undefined ? undefined : JSON.stringify(value);
        if (this.appliedNames.has(uuid) && this.appliedNames.get(uuid) === key) return;
        this.recordApply(this.options.host.setEntryName(uuid, value));
        this.appliedNames.set(uuid, key);
    }

    private recordApply(result: ApplyResult): void {
        switch (result.kind) {
            case 'applied':
            case 'unchanged':
                return;
            case 'unsupported':
                return;
            case 'failed':
                this.lastFailure = result.error;
                return;
        }
    }

    private resetDisconnected(players: readonly PlayerSnapshot[]): void {
        const current = new Set(players.map(({ uuid }) => uuid));
        for (const uuid of this.previousOnline) {
            if (current.has(uuid)) continue;
            this.safeReset(uuid);
            this.appliedNames.delete(uuid);
            this.appliedOrders.delete(uuid);
            this.appliedHeaders.delete(uuid);
        }
        this.previousOnline = current;
    }

    private safeReset(uuid: string): void {
        try {
            this.options.host.resetOwned(uuid);
        } catch {
            this.lastFailure = 'Could not restore plugin-owned tab fields';
        }
    }

    private clearApplied(): void {
        this.appliedNames.clear();
        this.appliedOrders.clear();
        this.appliedHeaders.clear();
    }

    private providerAvailable(): boolean {
        const state = this.options.resolver.state;
        return state === undefined || state.kind === 'ready';
    }

    private readClock(): number | undefined {
        const now = this.options.now();
        if (!Number.isFinite(now)) {
            this.lastFailure = 'Display clock returned an invalid value';
            return undefined;
        }
        return now;
    }
}

function makeTarget(config: TemplateLineConfig): RenderTarget {
    const { text, color, bold, italic, underlined, strikethrough } = config;
    const style: Omit<RenderedLine, 'text'> = {
        ...(color === undefined ? {} : { color }),
        ...(bold === undefined ? {} : { bold }),
        ...(italic === undefined ? {} : { italic }),
        ...(underlined === undefined ? {} : { underlined }),
        ...(strikethrough === undefined ? {} : { strikethrough })
    };
    return { template: compileTemplate(text), style };
}

function targetsOf(player: PreparedPlayer): readonly RenderTarget[] {
    return [...(player.entry === undefined ? [] : [player.entry]), ...player.header, ...player.footer];
}

function jobKey(player: PlayerSnapshot, template: string): string {
    return JSON.stringify([player.uuid, player.name, template]);
}

function fitBatch(jobs: readonly PlaceholderJob[], offset: number, countLimit: number): readonly PlaceholderJob[] {
    const result: PlaceholderJob[] = [];
    let bytes = strToU8('{"op":"set_placeholders_batch","requests":[]}').length;
    for (let index = offset; index < jobs.length && result.length < countLimit; index += 1) {
        const job = jobs[index];
        if (job === undefined) break;
        const single =
            strToU8(JSON.stringify({ op: 'set_placeholders_batch', requests: [job.request] })).length -
            strToU8('{"op":"set_placeholders_batch","requests":[]}').length;
        const extra = single + (result.length > 0 ? 1 : 0);
        if (bytes + extra > 1_048_576) break;
        result.push(job);
        bytes += extra;
    }
    return result;
}

function renderTemplateFallback(target: RenderTarget, config: TabDisplayConfig): RenderedLine {
    const policy = fallback(config.placeholders.missing_provider);
    return { text: renderTemplate(target.template, undefined, policy, false), ...target.style };
}

function fallback(value: string): 'literal' | 'empty' {
    return value === 'empty' ? 'empty' : 'literal';
}

function copySnapshot(snapshot: PlayerSnapshot): PlayerSnapshot {
    return {
        uuid: snapshot.uuid,
        name: snapshot.name,
        edition: snapshot.edition,
        ...(snapshot.javaVersion === undefined ? {} : { javaVersion: snapshot.javaVersion }),
        ...(snapshot.ping === undefined ? {} : { ping: snapshot.ping })
    };
}

function formatIssues(result: Extract<ConfigValidation, { kind: 'invalid' }>): string {
    return result.issues.map(({ path, reason }) => `${path}: ${reason}`).join('; ');
}
