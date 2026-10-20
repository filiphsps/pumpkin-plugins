import { ansi } from '@pumpkin-plugins/minecraft-colors';
import type { DataFiles } from '@pumpkin-plugins/plugin-kit/files';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import {
    formatIpv4,
    type MappingSpec,
    type MappingState,
    type Network,
    PortMapper,
    Task,
} from '@pumpkin-plugins/port-mapping';
import {
    decodeRequest,
    encodeReply,
    type NetworkInfo,
    type PortStatus,
    type Reply,
} from '@pumpkin-plugins/upnpumpkin-api';
import { blockedReason } from './blocklist.ts';
import { parseEndpoint } from './config/fields.ts';
import { loadPluginConfig } from './config/load.ts';
import type { Config } from './config/schema.ts';
import { ownKey, pluginKey } from './keys.ts';
import { type Refusal, refusalMessage } from './refusal.ts';

/** A request nobody has repeated for this long is dropped: the plugin that asked is gone. */
const REQUEST_TTL_MS = 5 * 60_000;
const PRUNE_EVERY_MS = 10_000;
/** How long stopping may wait for the router to confirm that ports were closed. */
const SHUTDOWN_BUDGET_MS = 3000;
/** How long stopping blocks between checks on the router's answers. */
const SHUTDOWN_POLL_MS = 10;

interface PluginRequest {
    lastSeen: number;
    sender: string;
    spec: MappingSpec;
}

/** The wire form of a mapper state. */
export function toStatus(state: MappingState | undefined): PortStatus {
    if (!state) return { kind: 'unknown' };
    if (state.kind === 'open')
        return { kind: 'open', via: state.via, address: formatIpv4(state.address), port: state.port };
    return state;
}

/**
 * The plugin's brain: keeps the Java and Bedrock ports open, answers other plugins' requests for
 * ports, and drives the port mapper. Everything it needs from the host comes in through its
 * constructor, so it can be tested without a server.
 */
export class PortForwarder {
    private settings: Config | undefined;
    private mapper: PortMapper | undefined;
    private mapperSettings = '';
    private mapperDriven = false;
    private retiring: { task: Task<void>; deadline: number } | undefined;
    private readonly requests = new Map<string, PluginRequest>();
    private lastPrune = 0;
    private readonly warnedSenders = new Set<string>();

    /** Creates a forwarder. Call `start` to begin. */
    constructor(
        private readonly files: DataFiles,
        private readonly log: Logger,
        private readonly net: Network,
    ) {}

    /** The current settings. Only available after `start`. */
    get config(): Config {
        if (!this.settings) throw new Error('PortForwarder has not been started');
        return this.settings;
    }

    /** What the mapper knows. Empty before `start`. */
    get snapshot() {
        return {
            info: this.mapper?.info() ?? {},
            mappings: this.mapper?.mappings() ?? [],
        };
    }

    /** Set once the router has been found to be one UPnPumpkin does not work with. Nothing is opened then. */
    get refusal(): Refusal | undefined {
        return this.mapper?.info().refused;
    }

    /** Loads the config and starts opening ports. */
    start(): void {
        this.reload();
    }

    /**
     * Reloads `config.toml`. The router is searched for again only when its settings changed.
     * @throws {ConfigSyntaxError} When the file is not valid TOML. The current settings stay.
     */
    reload(): void {
        this.settings = loadPluginConfig(this.files, this.log, this.settings);
        // The lease plays no part in finding the router; the mapper reads it at each renewal.
        const { lease_seconds: _lease, ...router } = this.settings.router;
        const key = JSON.stringify(router);
        if (this.mapper && key !== this.mapperSettings) this.retireMapper();
        if (!this.mapper) this.openMapper(key);
        this.applyOwnPorts();
    }

    /** Runs once per game tick. */
    tick(): void {
        if (this.retiring) {
            const { task, deadline } = this.retiring;
            const state = task.poll();
            if (state.state === 'running') {
                if (this.net.now() < deadline) return;
                task.cancel();
            }
            this.retiring = undefined;
        }
        if (!this.mapper) return;
        this.mapperDriven = true;
        this.mapper.tick();
        const now = this.net.now();
        if (now - this.lastPrune >= PRUNE_EVERY_MS) {
            this.lastPrune = now;
            this.pruneRequests(now);
        }
    }

    /**
     * Answers a message from another plugin.
     * @param sender - The plugin that sent it, as Pumpkin reports it.
     * @param bytes - The message.
     * @returns The reply, always: errors are reported in it rather than thrown.
     */
    handleMessage(sender: string, bytes: Uint8Array): Uint8Array {
        return encodeReply(this.answer(sender, bytes));
    }

    /** Closes every port and stops. Waits a moment for the router to confirm. */
    stop(): void {
        this.closeMapper();
        this.requests.clear();
    }

    private answer(sender: string, bytes: Uint8Array): Reply {
        const decoded = decodeRequest(bytes);
        if ('error' in decoded) return { ok: false, error: decoded.error };
        if (!this.settings || !this.mapper) return { ok: false, error: 'UPnPumpkin is not ready yet' };
        const { request } = decoded;
        const key = 'key' in request ? pluginKey(sender, request.key) : '';

        switch (request.op) {
            case 'info':
                return { ok: true, info: this.networkInfo() };
            case 'status':
                return { ok: true, status: toStatus(this.mapper.state(key)) };
            case 'release':
                this.requests.delete(key);
                this.mapper.release(key);
                return { ok: true };
            case 'ensure': {
                // Only asking for a port is turned off. A plugin must keep being able to give one
                // back and to read about it, or its ports would stay open after the operator
                // stopped requests.
                if (!this.settings.plugins.allow_requests) {
                    return {
                        ok: false,
                        error: 'requests from other plugins are turned off in the UPnPumpkin config (plugins.allow_requests)',
                    };
                }
                if (!this.settings.plugins.allowed.includes(sender)) {
                    if (!this.warnedSenders.has(sender)) {
                        this.warnedSenders.add(sender);
                        this.log.warn(
                            `${ansi.named.name(sender)} asked for ${request.protocol.toUpperCase()} port ${ansi.named.port(request.port)} to be opened, but it is not in plugins.allowed in the UPnPumpkin config.`,
                        );
                    }
                    return {
                        ok: false,
                        error: `${sender} may not ask for ports: add it to plugins.allowed in the UPnPumpkin config`,
                    };
                }
                const known = this.requests.has(key);
                const requestCount = [...this.requests.values()].filter((current) => current.sender === sender).length;
                if (!known && requestCount >= this.settings.plugins.max_requests_per_plugin) {
                    return {
                        ok: false,
                        error: `at most ${this.settings.plugins.max_requests_per_plugin} ports can be requested per plugin`,
                    };
                }
                if (!known)
                    this.log.info(
                        `${ansi.named.name(sender)} asked for ${request.protocol.toUpperCase()} port ${ansi.named.port(request.port)} to be opened (${request.description}).`,
                    );
                this.requests.set(key, { sender, spec: request, lastSeen: this.net.now() });
                return { ok: true, status: toStatus(this.mapper.request(key, request)) };
            }
        }
    }

    private networkInfo(): NetworkInfo {
        const { localAddress, gateway, externalAddress } = this.mapper?.info() ?? {};
        return {
            localAddress: localAddress && formatIpv4(localAddress),
            gateway: gateway && { kind: gateway.kind, address: formatIpv4(gateway.address) },
            externalAddress: externalAddress && formatIpv4(externalAddress),
        };
    }

    private openMapper(settingsKey: string): void {
        const { router } = this.config;
        const settings = () => this.config.router;
        this.mapperSettings = settingsKey;
        this.mapper = new PortMapper(this.net, {
            upnp: router.upnp,
            natPmp: router.nat_pmp,
            get leaseSeconds() {
                return settings().lease_seconds;
            },
            ssdp: parseEndpoint(router.upnp_search),
            natPmpGateway: parseEndpoint(router.nat_pmp_gateway),
            screen: blockedReason,
            onRefused: (refusal) => this.log.warn(refusalMessage(refusal)),
            log: (message, level) => (level === 'warn' ? this.log.warn(message) : this.log.info(message)),
        });
        for (const [key, { spec }] of this.requests) this.mapper.request(key, spec);
    }

    private retireMapper(): void {
        const mapper = this.mapper;
        this.mapper = undefined;
        // Replacements are not ticked until retirement settles. Repeated reloads can therefore
        // discard an unstarted replacement without allocating another cleanup task or transport.
        if (mapper && this.mapperDriven) {
            this.retiring = { task: new Task(mapper.releaseAll()), deadline: this.net.now() + SHUTDOWN_BUDGET_MS };
        }
        this.mapperDriven = false;
    }

    private closeMapper(): void {
        this.retireMapper();
        const closing = this.retiring?.task;
        this.retiring = undefined;
        if (!closing) return;
        const deadline = this.net.now() + SHUTDOWN_BUDGET_MS;
        try {
            // Only unload drains synchronously; live reload advances retirement on ticks.
            for (let now = this.net.now(); closing.poll().state === 'running' && now < deadline; ) {
                this.net.pause?.(Math.min(SHUTDOWN_POLL_MS, deadline - now));
                now = this.net.now();
            }
        } finally {
            closing.cancel();
        }
    }

    private applyOwnPorts(): void {
        const mapper = this.mapper;
        if (!mapper) return;
        const { java, bedrock } = this.config;
        // Bedrock players reach the server over UDP, but Pumpkin's NetherNet listener sets each
        // connection up over HTTP on the same port number, so Bedrock needs both protocols.
        const own = [
            { name: 'java', setting: java, protocol: 'tcp' as const, description: 'Pumpkin Java Edition' },
            { name: 'bedrock', setting: bedrock, protocol: 'udp' as const, description: 'Pumpkin Bedrock Edition' },
            {
                name: 'bedrock-tcp',
                setting: bedrock,
                protocol: 'tcp' as const,
                description: 'Pumpkin Bedrock Edition signaling',
            },
        ];
        for (const { name, setting, protocol, description } of own) {
            if (setting.enabled) mapper.request(ownKey(name), { protocol, port: setting.port, description });
            else mapper.release(ownKey(name));
        }
    }

    private pruneRequests(now: number): void {
        for (const [key, { sender, lastSeen }] of this.requests) {
            if (now - lastSeen < REQUEST_TTL_MS) continue;
            this.requests.delete(key);
            this.mapper?.release(key);
            this.log.info(`${ansi.named.name(sender)} stopped asking, so its port was closed.`);
        }
    }
}
