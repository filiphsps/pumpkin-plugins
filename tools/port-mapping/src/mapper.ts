import { type Discovered, type DiscoveryOptions, discover } from './discover.ts';
import type { GatewayKind, MappingRequest, MappingResult, Protocol } from './gateway.ts';
import { PortInUseError } from './gateway.ts';
import { describeIdentity, type RouterIdentity, RouterRefusedError } from './identify.ts';
import { formatIpv4, type Ipv4, isPublicIpv4 } from './ipv4.ts';
import type { Network } from './network.ts';
import { type Steps, Task } from './task.ts';

/** What to keep open. */
export interface MappingSpec {
    protocol: Protocol;
    /** The port on this machine. */
    port: number;
    /** The public port to ask for. Defaults to `port`; the router may give another one. */
    externalPort?: number;
    /** Shown in the router's list of forwarded ports. */
    description: string;
}

/** Whether a mapping works yet, and where players reach it. */
export type MappingState =
    | { kind: 'pending' }
    | { kind: 'open'; via: 'public' | GatewayKind; address: Ipv4; port: number }
    | { kind: 'failed'; reason: string };

/** What the mapper has learned about the network. */
export interface MapperInfo {
    /** This machine's address toward the internet. */
    localAddress?: Ipv4;
    /** The router that opens the ports. */
    gateway?: { kind: GatewayKind; address: Ipv4 };
    /** The router's address on the internet side. */
    externalAddress?: Ipv4;
    /** What is known about the router's make and model. */
    identity?: RouterIdentity;
    /** Set when the router was turned down by the `screen`: nothing is opened on it and it is not asked again. */
    refused?: { identity: RouterIdentity; reason: string };
}

/** Settings of a `PortMapper`. */
export interface MapperOptions extends Omit<DiscoveryOptions, 'searchMs'> {
    /** How long routers keep a mapping without a renewal. Renewed at half this time. */
    leaseSeconds: number;
    /** How long a UPnP search waits for answers. */
    searchMs?: number;
    /**
     * Where messages for the server log go. Failures come with the level `warn`, and each is said
     * once until a port opens, so a router that stays away doesn't fill the log.
     */
    log?: (message: string, level?: 'info' | 'warn') => void;
    /** Called once when the `screen` turns the router down. The mapper logs nothing about it. */
    onRefused?: (refusal: { identity: RouterIdentity; reason: string }) => void;
    /** A number in [0, 1), for choosing another public port when the first is taken. */
    random?: () => number;
}

interface Entry {
    spec: MappingSpec;
    mapping: PhysicalMapping;
}

interface PhysicalMapping {
    spec: MappingSpec;
    state: MappingState;
    applied?: { found: Discovered; request: MappingRequest; result: MappingResult };
    renewAt?: number;
    retryAt: number;
    failures: number;
}

const RETRY_MS = 30_000;
const MAX_RETRY_MS = 10 * 60_000;
const LOCAL_CHECK_MS = 60_000;
const PORT_TRIES = 3;

const sameSpec = (a: MappingSpec, b: MappingSpec) =>
    a.protocol === b.protocol &&
    a.port === b.port &&
    a.externalPort === b.externalPort &&
    a.description === b.description;

const backoff = (failures: number) => Math.min(RETRY_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_MS);
const refusedText = ({ identity, reason }: { identity: RouterIdentity; reason: string }) =>
    `${describeIdentity(identity)} cannot be used: ${reason}`;
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Keeps a set of ports open on the router: finds the router, opens each port, renews it before the
 * lease ends and closes it when it is released. When this machine already has a public address
 * nothing is opened. Driven by `tick`, one network operation at a time.
 */
export class PortMapper {
    private readonly entries = new Map<string, Entry>();
    private removals: NonNullable<PhysicalMapping['applied']>[] = [];
    private discovered: Discovered | undefined;
    private job: Task<void> | undefined;
    private discoveryRetryAt = 0;
    private discoveryFailures = 0;
    private lastDiscoveryFailure: string | undefined;
    private refusal: { identity: RouterIdentity; reason: string } | undefined;
    private lastFound: string | undefined;
    private readonly warned = new Map<string, string>();
    private local: { address: Ipv4 | undefined; checkedAt: number } | undefined;

    /** Creates a mapper that does nothing until a mapping is requested. */
    constructor(
        private readonly net: Network,
        private readonly options: MapperOptions
    ) {}

    /**
     * Asks for a port to be kept open. Asking again with the same spec changes nothing.
     * @param key - Names the mapping, so it can be released.
     * @returns The state right now.
     */
    request(key: string, spec: MappingSpec): MappingState {
        const existing = this.entries.get(key);
        if (existing && sameSpec(existing.spec, spec)) return existing.mapping.state;
        if (existing) this.release(key);
        const state: MappingState = this.refusal
            ? { kind: 'failed', reason: refusedText(this.refusal) }
            : this.lastDiscoveryFailure && !this.discovered && this.net.now() < this.discoveryRetryAt
              ? { kind: 'failed', reason: this.lastDiscoveryFailure }
              : { kind: 'pending' };
        const shared = [...this.entries.values()].find(
            ({ spec: other }) =>
                other.protocol === spec.protocol &&
                other.port === spec.port &&
                (other.externalPort ?? other.port) === (spec.externalPort ?? spec.port)
        );
        const mapping = shared?.mapping ?? { spec, state, retryAt: 0, failures: 0 };
        this.entries.set(key, { spec, mapping });
        return mapping.state;
    }

    /** Stops keeping a port open. The router is told on a later tick. */
    release(key: string): void {
        const entry = this.entries.get(key);
        this.entries.delete(key);
        if (entry?.mapping.applied && !this.owned(entry.mapping)) this.removals.push(entry.mapping.applied);
    }

    /** Every mapping that was requested, with its state. */
    mappings(): { key: string; spec: MappingSpec; state: MappingState }[] {
        return [...this.entries].map(([key, { spec, mapping }]) => ({ key, spec, state: mapping.state }));
    }

    /** The state of a mapping, or undefined when it was never requested. */
    state(key: string): MappingState | undefined {
        return this.entries.get(key)?.mapping.state;
    }

    /** What has been learned about the network so far. */
    info(): MapperInfo {
        const gateway = this.discovered?.gateway;
        return {
            localAddress: this.local?.address,
            gateway: gateway && { kind: gateway.kind, address: gateway.address },
            externalAddress: this.discovered?.externalAddress,
            identity: this.refusal?.identity ?? this.discovered?.identity,
            refused: this.refusal
        };
    }

    /** Moves the work forward. Call it every game tick. */
    tick(): void {
        if (this.job) {
            if (this.job.poll().state === 'running') return;
            this.job = undefined;
        }
        if (this.entries.size === 0 && this.removals.length === 0) return;
        const now = this.net.now();

        if (this.publicHost(now)) return;
        if (!this.discovered) {
            if (this.entries.size > 0 && now >= this.discoveryRetryAt) this.start(this.search());
            return;
        }
        const gateway = this.discovered;
        const removal = this.removals.shift();
        if (removal) {
            this.start(this.close(removal.found, removal.request));
            return;
        }
        for (const [key, logical] of this.entries) {
            const entry = logical.mapping;
            const due =
                entry.state.kind === 'open'
                    ? entry.renewAt !== undefined && now >= entry.renewAt
                    : now >= entry.retryAt;
            if (due) {
                this.start(this.open(gateway, key, entry));
                return;
            }
        }
    }

    /** Closes every open port. Run it to the end when shutting down. */
    *releaseAll(): Steps<void> {
        this.job?.cancel();
        this.job = undefined;
        for (const key of [...this.entries.keys()]) this.release(key);
        for (const { found, request } of this.removals.splice(0)) {
            try {
                yield* found.gateway.deleteMapping(request);
            } catch {
                // The lease runs out by itself.
            }
        }
    }

    private owned(mapping: PhysicalMapping): boolean {
        return [...this.entries.values()].some((entry) => entry.mapping === mapping);
    }

    private start(steps: Steps<void>): void {
        this.job = new Task(steps);
        this.job.poll();
    }

    /** With a public address on this machine there is no router to ask. */
    private publicHost(now: number): boolean {
        if (!this.local || now - this.local.checkedAt >= LOCAL_CHECK_MS) {
            this.local = { address: this.net.localAddress(), checkedAt: now };
        }
        const address = this.local.address;
        if (!address || !isPublicIpv4(address)) return false;
        for (const entry of this.entries.values()) {
            entry.mapping.state = {
                kind: 'open',
                via: 'public',
                address,
                port: entry.spec.externalPort ?? entry.spec.port
            };
        }
        return true;
    }

    private *search(): Steps<void> {
        const { log } = this.options;
        try {
            const found = yield* discover(this.net, this.options);
            if (!isPublicIpv4(found.externalAddress)) {
                const text = `the router's address on the internet is ${formatIpv4(found.externalAddress)}, which is not public (your provider shares one address between customers)`;
                this.discoveryFailed(text);
                return;
            }
            this.discovered = found;
            this.discoveryFailures = 0;
            this.lastDiscoveryFailure = undefined;
            this.warned.delete('discovery');
            const what = found.identity ? ` (${describeIdentity(found.identity)})` : '';
            const message = `Found a ${found.gateway.kind} router at ${formatIpv4(found.gateway.address)}${what}; its public address is ${formatIpv4(found.externalAddress)}.`;
            // Losing and finding the same router again is not news.
            if (message !== this.lastFound) log?.(message);
            this.lastFound = message;
        } catch (err) {
            if (err instanceof RouterRefusedError) this.refuse(err);
            else this.discoveryFailed(reason(err));
        }
    }

    private refuse({ identity, reason: why }: RouterRefusedError): void {
        this.refusal = { identity, reason: why };
        this.discoveryRetryAt = Number.POSITIVE_INFINITY;
        for (const entry of this.entries.values())
            entry.mapping.state = { kind: 'failed', reason: refusedText(this.refusal) };
        this.options.onRefused?.(this.refusal);
    }

    /**
     * Warns of a failure the first time it happens. It comes back with every retry, and once is
     * enough: the same message for the same `topic` is only logged again after the topic recovered.
     */
    private warn(topic: string, message: string): void {
        if (this.warned.get(topic) === message) return;
        this.warned.set(topic, message);
        this.options.log?.(message, 'warn');
    }

    private discoveryFailed(text: string): void {
        this.discoveryFailures++;
        this.lastDiscoveryFailure = text;
        this.discoveryRetryAt = this.net.now() + backoff(this.discoveryFailures);
        for (const entry of this.entries.values()) entry.mapping.state = { kind: 'failed', reason: text };
        this.warn('discovery', `No router could open ports: ${text}.`);
    }

    private *open(found: Discovered, key: string, entry: PhysicalMapping): Steps<void> {
        const { gateway } = found;
        const wasOpen = entry.state.kind === 'open';
        try {
            const internal = this.net.localAddress(gateway.address);
            if (!internal) throw new Error('this machine has no route to the router');
            let externalPort = entry.applied?.result.externalPort ?? entry.spec.externalPort ?? entry.spec.port;
            for (let attempt = 1; ; attempt++) {
                const request: MappingRequest = {
                    protocol: entry.spec.protocol,
                    internalPort: entry.spec.port,
                    externalPort,
                    description: entry.spec.description,
                    leaseSeconds: this.options.leaseSeconds
                };
                try {
                    const result = yield* gateway.addMapping(request, internal);
                    entry.applied = { found, request: { ...request, externalPort: result.externalPort }, result };
                    break;
                } catch (err) {
                    if (!(err instanceof PortInUseError) || attempt >= PORT_TRIES) throw err;
                    externalPort = 1024 + Math.floor((this.options.random ?? Math.random)() * 64000);
                }
            }
            const address = yield* gateway.externalAddress();
            if (!this.owned(entry)) return;
            const { result } = entry.applied;
            entry.state = { kind: 'open', via: gateway.kind, address, port: result.externalPort };
            entry.failures = 0;
            this.warned.delete(`open:${key}`);
            entry.renewAt = result.leaseSeconds > 0 ? this.net.now() + (result.leaseSeconds * 1000) / 2 : undefined;
            if (!wasOpen) {
                this.options.log?.(
                    `Opened ${entry.spec.protocol.toUpperCase()} port ${entry.spec.port} as ${formatIpv4(address)}:${result.externalPort} (${gateway.kind}).`
                );
            }
        } catch (err) {
            if (!this.owned(entry)) return;
            entry.failures++;
            entry.retryAt = this.net.now() + backoff(entry.failures);
            entry.renewAt = undefined;
            entry.state = {
                kind: 'failed',
                reason: `the router would not open port ${entry.spec.port}: ${reason(err)}`
            };
            this.warn(
                `open:${key}`,
                `Could not open ${entry.spec.protocol.toUpperCase()} port ${entry.spec.port}: ${reason(err)}.`
            );
            // The router may have gone or changed; look for it again when it is time to retry.
            this.discovered = undefined;
            this.discoveryRetryAt = entry.retryAt;
        }
    }

    private *close(found: Discovered, request: MappingRequest): Steps<void> {
        try {
            yield* found.gateway.deleteMapping(request);
        } catch {
            // The lease runs out by itself.
        }
    }
}
