import { encodeRequest, LIMITS, type ResolvedLine, type SessionState } from '@pumpkin-plugins/pumpkin-pie-api';
import { strToU8 } from 'fflate';
import type { TabDisplayConfig, TemplateLineConfig } from './config.ts';
import type { ApplyResult, PlayerSnapshot, RenderedLine, TabDisplayStatus } from './model.ts';
import { type CompiledTemplate, compileTemplate, renderTemplate } from './templates.ts';

/** One request sent to the shared PumpkinPIE client. */
export interface PlaceholderRequest {
    readonly text: string;
    readonly viewer?: string;
}

/** Host-independent subset of the shared PumpkinPIE client used by the scheduler. */
export interface TabPlaceholderResolver {
    resolveBatch(requests: readonly PlaceholderRequest[]): readonly ResolvedLine[];
    readonly state?: SessionState;
}

/** Host calls required by the pure service; adapters copy and dispose WASI resources themselves. */
export interface TabDisplayHost {
    /** Restores only fields currently owned by this plugin. */
    resetOwned(uuid: string): void;
    /** Applies a global subject row name. Undefined clears the custom name. */
    setEntryName(uuid: string, value: RenderedLine | undefined): ApplyResult;
    /** Applies a personalized viewer header and footer. */
    setHeaderFooter(uuid: string, header: readonly RenderedLine[], footer: readonly RenderedLine[]): ApplyResult;
    /** Copies bounded player primitives from the host. */
    snapshotPlayers(limit: number): readonly PlayerSnapshot[];
}

/** Dependencies of the host-independent display service. */
export interface TabDisplayServiceOptions {
    readonly config: TabDisplayConfig;
    readonly host: TabDisplayHost;
    readonly log?: (message: string) => void;
    readonly now: () => number;
    readonly resolver: TabPlaceholderResolver;
}

/** Maximum placeholder jobs resolved on a single game tick. */
export const MAX_JOBS_PER_TICK = 256;
/** Maximum time a previous placeholder frame is retained during provider outages. */
export const STALE_FRAME_MS = 30_000;
const RESET_FAILURE = 'Could not restore plugin-owned tab fields';
const EMPTY_BATCH_BYTES = encodeRequest({ op: 'set_placeholders_batch', requests: [] }).length;

interface RenderTarget {
    readonly style: Omit<RenderedLine, 'text'>;
    readonly template: CompiledTemplate;
}

interface PreparedPlayer {
    readonly entry?: RenderTarget;
    readonly footer: readonly RenderTarget[];
    readonly header: readonly RenderTarget[];
    readonly snapshot: PlayerSnapshot;
}

interface PlaceholderJob {
    readonly key: string;
    readonly request: PlaceholderRequest;
}

interface PendingGeneration {
    cursor: number;
    readonly jobs: readonly PlaceholderJob[];
    readonly players: readonly PreparedPlayer[];
    readonly results: Map<string, ResolvedLine>;
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
    private readonly appliedHeaders = new Map<string, string>();
    private readonly unsupportedNames = new Set<string>();
    private readonly unsupportedHeaders = new Set<string>();
    private readonly playerCapabilities = new Map<string, string>();
    private readonly disableResetPending = new Set<string>();
    private latestPlayers: readonly PlayerSnapshot[] = [];
    private disabled = false;
    private overLimit = false;

    /** Creates the service from a loaded config snapshot. */
    constructor(private readonly options: TabDisplayServiceOptions) {
        this.config = options.config;
    }

    /** Swaps in a loaded configuration and starts a fresh refresh on the next tick. */
    setConfig(config: TabDisplayConfig): void {
        this.config = config;
        this.pending = undefined;
        this.nextRefreshTick = this.tickNumber;
        this.lastFailure = undefined;
    }

    /** Returns one copied online snapshot and configured placeholder IDs, never resolved values. */
    inspect(uuid: string): (PlayerSnapshot & { readonly placeholderIds: readonly string[] }) | undefined {
        const snapshot = this.latestPlayers.find((player) => player.uuid === uuid);
        if (snapshot === undefined) return undefined;
        const sources = [
            ...(snapshot.edition === 'java' && this.config.entry.enabled ? [this.config.entry.text] : []),
            ...(snapshot.edition === 'java' ? this.config.header.lines.map(({ text }) => text) : []),
            ...(snapshot.edition === 'java' ? this.config.footer.lines.map(({ text }) => text) : []),
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
            if (!this.overLimit) this.options.log?.(`${this.lastFailure}; display updates are paused`);
            this.overLimit = true;
            return;
        }
        if (this.overLimit) {
            this.overLimit = false;
            this.options.log?.('Online player count is within general.max_players again; display updates resumed');
        }
        this.latestPlayers = snapshots.map(copySnapshot);
        this.syncPlayerCapabilities(this.latestPlayers);

        if (!this.config.general.enabled) {
            if (!this.disabled) {
                for (const player of this.latestPlayers) this.disableResetPending.add(player.uuid);
                let resetSucceeded = true;
                for (const uuid of this.disableResetPending) {
                    if (!this.safeReset(uuid)) resetSucceeded = false;
                }
                if (resetSucceeded) {
                    this.disableResetPending.clear();
                    this.clearDisplayCaches();
                    this.disabled = true;
                    if (this.lastFailure === RESET_FAILURE) this.lastFailure = undefined;
                }
            }
            this.pending = undefined;
            this.previousOnline = new Set(this.latestPlayers.map(({ uuid }) => uuid));
            return;
        }
        if (this.disableResetPending.size > 0) this.clearDisplayCaches();
        this.disableResetPending.clear();
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
        this.clearDisplayCaches();
        this.previousOnline.clear();
    }

    /** Reports safe runtime state without resolved placeholder values or player names. */
    status(): TabDisplayStatus {
        const state = this.options.resolver.state;
        const javaPlayers = this.latestPlayers.filter(({ edition }) => edition === 'java').length;
        const bedrockPlayers = this.latestPlayers.filter(({ edition }) => edition === 'bedrock').length;
        const javaVersions = [
            ...new Set(this.latestPlayers.flatMap(({ javaVersion }) => (javaVersion ? [javaVersion] : []))),
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
            bedrock: {
                kind: 'unsupported',
                reason: 'TabDisplay leaves the native Bedrock player list unchanged.',
            },
        };
    }

    private prepareGeneration(players: readonly PlayerSnapshot[]): PendingGeneration {
        const prepared = players.map((snapshot) => ({
            snapshot,
            ...(snapshot.edition === 'java' && this.config.entry.enabled
                ? {
                      entry: makeTarget({
                          text: this.config.entry.text,
                          color: this.config.entry.color,
                          bold: this.config.entry.bold,
                          italic: this.config.entry.italic,
                          underlined: this.config.entry.underlined,
                          strikethrough: this.config.entry.strikethrough,
                      }),
                  }
                : {}),
            header: snapshot.edition === 'java' ? this.config.header.lines.map(makeTarget) : [],
            footer: snapshot.edition === 'java' ? this.config.footer.lines.map(makeTarget) : [],
        }));

        const jobs = new Map<string, PlaceholderJob>();
        for (const player of prepared) {
            for (const target of targetsOf(player)) {
                if (!target.template.hasPlaceholders) continue;
                const key = jobKey(player.snapshot, target.template.source);
                jobs.set(key, {
                    key,
                    request: { text: target.template.source, viewer: player.snapshot.name },
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
                const builtins = builtinValues(player.snapshot, generation.players.length);
                const render = (target: RenderTarget): RenderedLine => {
                    const resolution = target.template.hasPlaceholders
                        ? generation.results.get(jobKey(player.snapshot, target.template.source))
                        : undefined;
                    if (resolution) for (const id of resolution.unresolved) unresolved.add(id);
                    const policy = providerAvailable
                        ? fallback(this.config.placeholders.unresolved)
                        : fallback(this.config.placeholders.missing_provider);
                    return {
                        text: renderTemplate(target.template, resolution, policy, providerAvailable, builtins),
                        ...target.style,
                    };
                };
                return {
                    snapshot: player.snapshot,
                    entry: player.entry === undefined ? undefined : render(player.entry),
                    header: player.header.map(render),
                    footer: player.footer.map(render),
                };
            });
            if (providerAvailable) this.lastSuccessfulAt = now;
            this.unresolved = unresolved;
            phase = 'updating';
            const failed = this.applyGeneration(rendered);
            this.pending = undefined;
            if (!failed) this.lastFailure = undefined;
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
            const rendered = generation.players.map((player) => {
                const builtins = builtinValues(player.snapshot, generation.players.length);
                const render = (target: RenderTarget) => renderTemplateFallback(target, this.config, builtins);
                return {
                    snapshot: player.snapshot,
                    entry: player.entry === undefined ? undefined : render(player.entry),
                    header: player.header.map(render),
                    footer: player.footer.map(render),
                };
            });
            this.applyGeneration(rendered);
        } catch {
            this.lastFailure = 'Could not apply the fallback display';
        }
    }

    private applyGeneration(
        rendered: readonly {
            readonly snapshot: PlayerSnapshot;
            readonly entry: RenderedLine | undefined;
            readonly header: readonly RenderedLine[];
            readonly footer: readonly RenderedLine[];
        }[],
    ): boolean {
        let failed = false;
        for (const item of rendered) {
            const { snapshot } = item;
            if (snapshot.edition === 'java' && item.entry !== undefined) {
                if (this.applyName(snapshot.uuid, item.entry)) failed = true;
            } else if (snapshot.edition === 'java' && this.appliedNames.has(snapshot.uuid)) {
                if (this.applyName(snapshot.uuid, undefined)) failed = true;
            }
            if (snapshot.edition === 'java') {
                const key = JSON.stringify([item.header, item.footer]);
                if (!this.unsupportedHeaders.has(snapshot.uuid) && this.appliedHeaders.get(snapshot.uuid) !== key) {
                    const result = this.options.host.setHeaderFooter(snapshot.uuid, item.header, item.footer);
                    if (result.kind === 'unsupported') this.unsupportedHeaders.add(snapshot.uuid);
                    else if (this.recordApply(result)) this.appliedHeaders.set(snapshot.uuid, key);
                    else failed = true;
                }
            }
        }
        return failed;
    }

    private applyName(uuid: string, value: RenderedLine | undefined): boolean {
        const key = value === undefined ? undefined : JSON.stringify(value);
        if (this.appliedNames.has(uuid) && this.appliedNames.get(uuid) === key) return false;
        if (this.unsupportedNames.has(uuid)) return false;
        const result = this.options.host.setEntryName(uuid, value);
        if (result.kind === 'unsupported') {
            this.unsupportedNames.add(uuid);
            return false;
        }
        if (this.recordApply(result)) {
            this.appliedNames.set(uuid, key);
            return false;
        }
        return result.kind === 'failed';
    }

    private recordApply(result: ApplyResult): boolean {
        switch (result.kind) {
            case 'applied':
            case 'unchanged':
                return true;
            case 'unsupported':
                return false;
            case 'failed':
                this.lastFailure = result.error;
                return false;
        }
    }

    private resetDisconnected(players: readonly PlayerSnapshot[]): void {
        const current = new Set(players.map(({ uuid }) => uuid));
        for (const uuid of this.previousOnline) {
            if (current.has(uuid)) continue;
            this.safeReset(uuid);
            this.clearPlayerCaches(uuid);
        }
        this.previousOnline = current;
    }

    private syncPlayerCapabilities(players: readonly PlayerSnapshot[]): void {
        const current = new Map(players.map((player) => [player.uuid, playerCapabilityKey(player)]));
        for (const uuid of this.playerCapabilities.keys()) {
            if (!current.has(uuid)) this.clearPlayerCaches(uuid);
        }
        for (const [uuid, capability] of current) {
            if (this.playerCapabilities.has(uuid) && this.playerCapabilities.get(uuid) !== capability) {
                this.clearPlayerCaches(uuid);
            }
            this.playerCapabilities.set(uuid, capability);
        }
    }

    private clearPlayerCaches(uuid: string): void {
        this.appliedNames.delete(uuid);
        this.appliedHeaders.delete(uuid);
        this.unsupportedNames.delete(uuid);
        this.unsupportedHeaders.delete(uuid);
        this.playerCapabilities.delete(uuid);
    }

    private safeReset(uuid: string): boolean {
        try {
            this.options.host.resetOwned(uuid);
            return true;
        } catch {
            this.lastFailure = RESET_FAILURE;
            return false;
        }
    }

    private clearDisplayCaches(): void {
        this.appliedNames.clear();
        this.appliedHeaders.clear();
        this.unsupportedNames.clear();
        this.unsupportedHeaders.clear();
        this.playerCapabilities.clear();
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

function playerCapabilityKey(player: PlayerSnapshot): string {
    return JSON.stringify([player.edition, player.javaVersion]);
}

function makeTarget(config: TemplateLineConfig): RenderTarget {
    const { text, color, bold, italic, underlined, strikethrough } = config;
    const style: Omit<RenderedLine, 'text'> = {
        ...(color === undefined ? {} : { color }),
        ...(bold === undefined ? {} : { bold }),
        ...(italic === undefined ? {} : { italic }),
        ...(underlined === undefined ? {} : { underlined }),
        ...(strikethrough === undefined ? {} : { strikethrough }),
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
    let bytes = EMPTY_BATCH_BYTES;
    for (let index = offset; index < jobs.length && result.length < countLimit; index += 1) {
        const job = jobs[index];
        if (job === undefined) break;
        // Each request adds its JSON plus a comma separator inside the batch's request array.
        const extra = strToU8(JSON.stringify(job.request)).length + (result.length > 0 ? 1 : 0);
        if (bytes + extra > LIMITS.message) break;
        result.push(job);
        bytes += extra;
    }
    return result;
}

function renderTemplateFallback(
    target: RenderTarget,
    config: TabDisplayConfig,
    builtins: ReadonlyMap<string, string>,
): RenderedLine {
    const policy = fallback(config.placeholders.missing_provider);
    return { text: renderTemplate(target.template, undefined, policy, false, builtins), ...target.style };
}

// ponytail: only the tokens the default config uses; anything else needs PumpkinPIE.
function builtinValues(player: PlayerSnapshot, online: number): ReadonlyMap<string, string> {
    return new Map([
        ['player_name', player.name],
        ['server_online', String(online)],
    ]);
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
    };
}
