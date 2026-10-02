import {
    MappingWatcher,
    openUrl,
    PortMapClient,
    type SendMessage,
    type WatchedState
} from '@pumpkin-plugins/upnpumpkin-api';
import { loadPluginConfig } from './config/load.ts';
import type { Config } from './config/schema.ts';
import type { PackEntry } from './packs/entries.ts';
import { publicBaseUrl } from './packs/entries.ts';
import { PackIndex } from './packs/pack-index.ts';
import type { DataFiles } from './platform/files.ts';
import type { Logger } from './platform/logger.ts';
import type { WebServer, WebServerSettings } from './web/server.ts';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** How long UPnPumpkin may stay unreachable before it is reported: it may simply load after this plugin. */
const FORWARDING_GRACE_MS = 30_000;

/**
 * The port to ask UPnPumpkin to open, or undefined when nothing should be asked. Port forwarding is
 * for a web server that listens everywhere and has no address of its own to give players.
 */
export function forwardedPortFor({ web }: Config): number | undefined {
    return web.enabled && web.port_forwarding && web.public_url === '' && web.bind === '0.0.0.0' ? web.port : undefined;
}

/** Creates the web server for a given pack index. */
export type WebServerFactory = (index: PackIndex) => WebServer;

/**
 * The plugin's brain: loads the config, scans the packs and keeps the web server running with the
 * right settings. It scans on start and on
 * `reload`, never on its own. Everything it needs from the host comes in through its
 * constructor, so it can be tested without a server.
 */
export class PackManager {
    private readonly index: PackIndex;
    private readonly server: WebServer;
    private settings: Config | undefined;
    private running: WebServerSettings | undefined;
    private readonly ports: PortMapClient;
    private watcher: MappingWatcher | undefined;
    private forwardedPort: number | undefined;
    private reachableUrl: string | undefined;
    private unavailableSince: number | undefined;
    private reportedUnavailable = false;
    private scanned = false;

    /**
     * Creates a manager. Call `start` to begin.
     * @param send - Sends an IPC message to another plugin, to reach UPnPumpkin.
     * @param now - The current time in milliseconds.
     */
    constructor(
        private readonly files: DataFiles,
        private readonly log: Logger,
        makeServer: WebServerFactory,
        send: SendMessage,
        private readonly now: () => number = Date.now
    ) {
        this.index = new PackIndex(files, log);
        this.server = makeServer(this.index);
        this.ports = new PortMapClient(send);
    }

    /** The current settings. Only available after `start`. */
    get config(): Config {
        if (!this.settings) throw new Error('PackManager has not been started');
        return this.settings;
    }

    /** The packs currently listed. */
    get entries(): readonly PackEntry[] {
        return this.index.entries;
    }

    /** Loads the config, finds the packs and starts the web server. */
    start(): void {
        this.reload();
    }

    /** Reloads `config.toml`, rescans the packs and restarts the web server if its settings changed. */
    reload(): void {
        this.settings = loadPluginConfig(this.files, this.log);
        this.applyForwarding();
        this.refresh();
        this.applyWebSettings();
        this.warnIfUrlIsLocal();
    }

    /** Runs once per game tick: serves downloads and keeps asking UPnPumpkin about the port. */
    tick(): void {
        if (!this.settings) return;
        this.server.tick();
        this.watcher?.tick();
        this.reportLateUnavailable();
    }

    /** Stops the web server and gives the port back to UPnPumpkin. */
    stop(): void {
        this.stopForwarding(false);
        this.server.stop();
        this.running = undefined;
    }

    private refresh(): void {
        const config = this.config;
        try {
            this.files.createDirectory(config.packs.directory);
            this.index.refresh(config, this.reachableUrl);
            this.scanned = true;
        } catch (err) {
            this.log.error(`Could not scan ${config.packs.directory}/: ${errorText(err)}`);
            return;
        }
        this.announce();
    }

    /** Starts, keeps, moves or stops asking UPnPumpkin to match the config. */
    private applyForwarding(): void {
        const wanted = forwardedPortFor(this.config);
        if (wanted === this.forwardedPort) return;

        this.stopForwarding();
        if (wanted === undefined) return;
        this.forwardedPort = wanted;
        const request = { key: 'web', protocol: 'tcp', port: wanted, description: 'Bedrock resource packs' } as const;
        this.watcher = new MappingWatcher(
            this.ports,
            request,
            (state) => this.forwardingChanged(wanted, state),
            this.now
        );
        this.watcher.start();
    }

    private stopForwarding(resetUrl = true): void {
        this.watcher?.stop();
        this.watcher = undefined;
        this.forwardedPort = undefined;
        this.unavailableSince = undefined;
        this.reportedUnavailable = false;
        if (resetUrl) this.setReachableUrl(undefined);
    }

    private forwardingChanged(port: number, state: WatchedState): void {
        this.unavailableSince = state.kind === 'unavailable' ? (this.unavailableSince ?? this.now()) : undefined;
        if (state.kind === 'open') {
            const url = openUrl(state);
            this.log.info(
                state.via === 'public'
                    ? `This machine has a public address, so clients download packs from ${url}.`
                    : `Opened port ${port} on the router (${state.via}): clients download packs from ${url}.`
            );
            this.setReachableUrl(url);
        } else if (state.kind === 'failed') {
            this.setReachableUrl(undefined);
            this.log.warn(
                `Could not make port ${port} reachable from the internet: ${state.reason}. Clients are told to download packs from http://127.0.0.1:${port}, which only works for players on this machine. Open the port yourself and set web.public_url, or set web.port_forwarding = false.`
            );
        } else if (state.kind === 'unavailable') {
            this.setReachableUrl(undefined);
        }
    }

    /** UPnPumpkin may load after this plugin, so a missing one is only reported once it has stayed missing. */
    private reportLateUnavailable(): void {
        if (this.unavailableSince === undefined || this.reportedUnavailable) return;
        if (this.now() - this.unavailableSince < FORWARDING_GRACE_MS) return;
        this.reportedUnavailable = true;
        const port = this.forwardedPort;
        this.log.warn(
            `web.port_forwarding is on, but the UPnPumpkin plugin does not answer, so clients are told to download packs from http://127.0.0.1:${port}, which only works for players on this machine. Install UPnPumpkin to open the port on your router automatically, set web.public_url to the address players can reach, or set web.port_forwarding = false.`
        );
    }

    /** Switches the address clients are told to use, and tells the packs about it. */
    private setReachableUrl(url: string | undefined): void {
        if (url === this.reachableUrl) return;
        this.reachableUrl = url;
        if (!this.scanned) return;
        this.index.rebuild(this.config, url);
        this.announce();
    }

    /** Stand-in for handing the packs to the server. Pumpkin has no plugin API for that yet, so it only says what would be offered. */
    private announce(): void {
        const count = this.index.entries.length;
        this.log.info(
            `Offering ${count} Bedrock pack${count === 1 ? '' : 's'} to players who join from now on (not connected to the server yet, so players are not sent them).`
        );
    }

    private applyWebSettings(): void {
        const { web } = this.config;
        const wanted = web.enabled ? { bind: web.bind, port: web.port } : undefined;
        if (wanted?.bind === this.running?.bind && wanted?.port === this.running?.port) return;

        this.server.stop();
        this.running = undefined;
        if (!wanted) {
            this.log.info('The web server is turned off (web.enabled = false).');
            return;
        }
        try {
            this.server.start(wanted);
            this.running = wanted;
            this.log.info(`Serving packs on http://${wanted.bind}:${wanted.port}/packs/.`);
        } catch (err) {
            this.log.error(`Could not start the web server: ${errorText(err)}`);
        }
    }

    private warnIfUrlIsLocal(): void {
        const base = publicBaseUrl(this.config, this.reachableUrl);
        const affected =
            this.config.web.enabled &&
            base.isDefault &&
            this.forwardedPort === undefined &&
            this.entries.some((e) => e.downloadUrl.startsWith(base.url));
        if (affected) {
            this.log.warn(
                `web.public_url is not set, so clients are told to download packs from ${base.url}, which only works for players on this machine. Set it to the address players can reach.`
            );
        }
    }
}
