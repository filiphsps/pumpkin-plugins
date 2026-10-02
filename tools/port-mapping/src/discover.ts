import type { Gateway } from './gateway.ts';
import { httpRequest } from './http.ts';
import { probeWeb, type RouterIdentity, RouterRefusedError, type Screen } from './identify.ts';
import type { Endpoint, Ipv4 } from './ipv4.ts';
import { formatIpv4 } from './ipv4.ts';
import { NAT_PMP_PORT, NatPmpGateway } from './natpmp.ts';
import type { Network } from './network.ts';
import { parseSearchResponse, SEARCH_TARGETS, SSDP_ADDRESS, searchRequest } from './ssdp.ts';
import { parallel, type Steps } from './task.ts';
import { type ControlPoint, parseDescription, parseIdentity, UpnpGateway } from './upnp.ts';
import { parseHttpUrl } from './url.ts';

/** What to look for and where. */
export interface DiscoveryOptions {
    /** Look for UPnP gateways. */
    upnp: boolean;
    /** Look for NAT-PMP gateways. */
    natPmp: boolean;
    /** Where to send UPnP searches. Defaults to the SSDP multicast group; a router's own address works when multicast is blocked. */
    ssdp?: Endpoint;
    /** The NAT-PMP gateway to use. Without it the usual router addresses of the local network are tried. */
    natPmpGateway?: Endpoint;
    /** How long a UPnP search waits for answers, in milliseconds. */
    searchMs?: number;
    /**
     * Turns routers down by what they are. It sees every router that gives away its make and model,
     * before anything is asked of it, and a router it gives a reason for is not used: when that
     * leaves no router, discovery throws a `RouterRefusedError`. Without it routers are not identified.
     */
    screen?: Screen;
}

/** A router that answered, and the address it has on the internet. */
export interface Discovered {
    gateway: Gateway;
    externalAddress: Ipv4;
    /** What is known about its make and model. */
    identity?: RouterIdentity;
}

/** A UPnP router that answered the search, and what it offers. */
interface UpnpCandidate {
    identity?: RouterIdentity;
    points: ControlPoint[];
}

/** How long to keep listening once the first router has answered, so slower ones can still be heard. */
const GRACE_MS = 750;
const MAX_LOCATIONS = 5;

/**
 * Finds a router that can open ports. UPnP and NAT-PMP are tried side by side; UPnP wins when both answer.
 *
 * With a `screen`, routers are identified first, and nothing is asked of one that is turned down:
 * its web interface is looked at, then UPnP devices describe themselves, and only then are the
 * protocols spoken. That makes a search take longer, since NAT-PMP waits for the UPnP search.
 * @throws {RouterRefusedError} When the only routers found are turned down by the `screen`.
 * @throws {Error} Saying why each protocol found nothing.
 */
export function* discover(net: Network, options: DiscoveryOptions): Steps<Discovered> {
    if (!options.upnp && !options.natPmp) throw new Error('UPnP and NAT-PMP are both turned off');

    let identity: RouterIdentity | undefined;
    if (options.screen) {
        identity = yield* probeWeb(net, gatewayAddresses(net, options));
        const reason = identity && options.screen(identity);
        if (identity && reason) throw new RouterRefusedError(reason, identity);
    }

    const jobs: { name: string; steps: Steps<Discovered> }[] = [];
    if (options.upnp) {
        try {
            const candidates = yield* surveyUpnp(net, options);
            jobs.push({ name: 'UPnP', steps: connectUpnp(net, candidates) });
        } catch (err) {
            if (err instanceof RouterRefusedError) throw err;
            jobs.push({ name: 'UPnP', steps: failWith(err) });
        }
    }
    if (options.natPmp) jobs.push({ name: 'NAT-PMP', steps: discoverNatPmp(net, options, identity) });

    const results = yield* parallel(jobs.map((j) => j.steps));
    const found = results.find((r) => r.ok);
    if (found?.ok) return found.value;
    const reasons = results.map((r, i) => `${jobs[i]?.name}: ${r.ok ? '' : r.error.message}`);
    throw new Error(reasons.join('; '));
}

// biome-ignore lint/correctness/useYield: it only exists to fail like the other jobs do.
function* failWith(err: unknown): Steps<Discovered> {
    throw err instanceof Error ? err : new Error(String(err));
}

/** Searches for UPnP routers and reads what each says about itself, leaving out those the `screen` turns down. */
function* surveyUpnp(net: Network, options: DiscoveryOptions): Steps<UpnpCandidate[]> {
    const locations = yield* search(net, options.ssdp ?? SSDP_ADDRESS, options.searchMs ?? 3000);
    if (locations.length === 0) throw new Error('no router answered the search');

    const candidates: UpnpCandidate[] = [];
    let refusal: RouterRefusedError | undefined;
    for (const location of locations.slice(0, MAX_LOCATIONS)) {
        const candidate = yield* describeSteps(net, location);
        const reason = candidate.identity && options.screen?.(candidate.identity);
        if (candidate.identity && reason) refusal ??= new RouterRefusedError(reason, candidate.identity);
        else candidates.push(candidate);
    }
    if (candidates.length === 0 && refusal) throw refusal;
    return candidates;
}

function* connectUpnp(net: Network, candidates: readonly UpnpCandidate[]): Steps<Discovered> {
    let lastError = 'the routers found have no port mapping service';
    for (const { identity, points } of candidates) {
        for (const point of points) {
            try {
                const gateway = new UpnpGateway(net, point);
                return { gateway, externalAddress: yield* gateway.externalAddress(), identity };
            } catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
            }
        }
    }
    throw new Error(lastError);
}

function* describeSteps(net: Network, location: string): Steps<UpnpCandidate> {
    const url = parseHttpUrl(location);
    if (!url) return { points: [] };
    try {
        const response = yield* httpRequest(net, url.endpoint, { method: 'GET', path: url.path });
        if (response.status !== 200) return { points: [] };
        return { points: parseDescription(response.body, location), identity: parseIdentity(response.body) };
    } catch {
        return { points: [] };
    }
}

function* search(net: Network, to: Endpoint, windowMs: number): Steps<string[]> {
    const socket = net.openDatagram();
    try {
        const start = net.now();
        const found = new Set<string>();
        let firstAt: number | undefined;
        let sends = 0;
        while (net.now() - start < windowMs && !(firstAt !== undefined && net.now() - firstAt > GRACE_MS)) {
            // UDP is lossy and routers are slow to wake, so ask twice.
            if (sends === 0 || (sends === 1 && net.now() - start >= 1000)) {
                for (const target of SEARCH_TARGETS) socket.send(to, searchRequest(target, to));
                sends++;
            }
            for (let d = socket.receive(); d; d = socket.receive()) {
                const location = parseSearchResponse(d.data);
                if (location && !found.has(location)) {
                    found.add(location);
                    firstAt ??= net.now();
                }
            }
            yield;
        }
        return [...found];
    } finally {
        socket.close();
    }
}

function* discoverNatPmp(
    net: Network,
    options: DiscoveryOptions,
    identity: RouterIdentity | undefined
): Steps<Discovered> {
    const candidates = natPmpCandidates(net, options);
    if (candidates.length === 0) throw new Error('this machine has no route to a local network');

    const results = yield* parallel(
        candidates.map(function* (to): Steps<Discovered> {
            const gateway = new NatPmpGateway(net, to.address, to.port);
            return { gateway, externalAddress: yield* gateway.externalAddress(), identity };
        })
    );
    const found = results.find((r) => r.ok);
    if (found?.ok) return found.value;
    throw new Error(`no answer from ${candidates.map((c) => formatIpv4(c.address)).join(' or ')}`);
}

/**
 * Where the router probably is: the gateway that was configured, or else the first and last
 * address of the local /24, which is where routers almost always are.
 */
function gatewayAddresses(net: Network, options: DiscoveryOptions): Ipv4[] {
    if (options.natPmpGateway) return [options.natPmpGateway.address];
    const local = net.localAddress();
    if (!local) return [];
    return [1, 254].map((last) => [local[0], local[1], local[2], last] as const);
}

function natPmpCandidates(net: Network, options: DiscoveryOptions): Endpoint[] {
    const port = options.natPmpGateway?.port ?? NAT_PMP_PORT;
    return gatewayAddresses(net, options).map((address) => ({ address, port }));
}
