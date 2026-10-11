import { instanceNetwork } from 'wasi:sockets/instance-network@0.2.3';
import type { TcpSocket } from 'wasi:sockets/tcp@0.2.3';
import { createTcpSocket } from 'wasi:sockets/tcp-create-socket@0.2.3';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import type { Logger } from '../platform/logger.ts';
import { wasiErrorCode } from '../platform/wasi-error.ts';
import { parseIpv4 } from './ipv4.ts';
import type { WebServer, WebServerSettings } from './server.ts';
import { HttpSession, type PackLookup, type SessionOptions, type TickQuota } from './session.ts';
import { TcpTransport } from './tcp-transport.ts';

/** Most simultaneous downloads. Further connections wait in the OS backlog. */
const MAX_CONNECTIONS = 64;
/** Most connections accepted in one tick, so a burst can't stall the server tick. */
const ACCEPTS_PER_TICK = 8;
/** Accepts, request/file reads, open/stat, capacity checks, writes and flush/shutdown calls. */
const OPERATIONS_PER_TICK = 64;
/** How often to retry a socket step that reports it would block. */
const MAX_SETTLE_ATTEMPTS = 100;

const SESSION_LIMITS: Omit<SessionOptions, 'now'> = {
    idleTimeoutMs: 15_000,
    writeBudget: 1 << 20,
    chunkSize: 256 << 10
};

const BIND_REASONS: Record<string, string> = {
    'address-in-use': 'the port is already in use',
    'address-not-bindable': 'that address does not belong to this machine',
    'access-denied': 'the server is not allowed to listen there (is network.tcp.bind granted?)',
    'permanently-unavailable': 'listening is not available'
};

/** Socket start/finish pairs may report `would-block` while the host works; try again until they settle. */
function settle<T>(step: () => T): T {
    for (let attempt = 1; ; attempt++) {
        try {
            return step();
        } catch (err) {
            if (wasiErrorCode(err) !== 'would-block' || attempt >= MAX_SETTLE_ATTEMPTS) throw err;
        }
    }
}

/** An HTTP server on a WASI TCP socket, serving packs from a lookup. Driven by `tick`. */
export class TcpWebServer implements WebServer {
    private listener: TcpSocket | undefined;
    private readonly sessions = new Set<HttpSession>();
    private cursor = 0;

    /** Creates a stopped server. */
    constructor(
        private readonly lookup: PackLookup,
        private readonly log: Logger,
        private readonly now: () => number = Date.now
    ) {}

    /** {@inheritDoc web/server!WebServer#start} */
    start(settings: WebServerSettings): void {
        this.stop();
        const address = parseIpv4(settings.bind);
        if (!address) throw new Error(`${settings.bind} is not an IPv4 address`);

        const socket = createTcpSocket('ipv4');
        try {
            socket.startBind(instanceNetwork(), { tag: 'ipv4', val: { port: settings.port, address } });
            settle(() => socket.finishBind());
            socket.setListenBacklogSize(128n);
            socket.startListen();
            settle(() => socket.finishListen());
        } catch (err) {
            try {
                disposeWasiResource(socket);
            } catch {
                // Preserve the socket setup error.
            }
            const code = wasiErrorCode(err) ?? String(err);
            throw new Error(`cannot listen on ${settings.bind}:${settings.port}: ${BIND_REASONS[code] ?? code}`);
        }
        this.listener = socket;
    }

    /** {@inheritDoc web/server!WebServer#tick} */
    tick(): void {
        if (!this.listener) return;
        const quota: TickQuota = { bytes: SESSION_LIMITS.writeBudget, operations: OPERATIONS_PER_TICK };
        this.acceptNew(this.listener, quota);
        const sessions = [...this.sessions];
        if (sessions.length === 0) return;
        const start = this.cursor % sessions.length;
        // Even exhausted sessions need deadlines/disposal checked; the starting owner rotates.
        for (let i = 0; i < sessions.length; i++) {
            const session = sessions[(start + i) % sessions.length];
            if (session && !session.tick(quota)) this.sessions.delete(session);
        }
        this.cursor = (start + 1) % sessions.length;
    }

    /** {@inheritDoc web/server!WebServer#stop} */
    stop(): void {
        for (const session of this.sessions) session.abort();
        this.sessions.clear();
        this.cursor = 0;
        if (this.listener) disposeWasiResource(this.listener);
        this.listener = undefined;
    }

    private acceptNew(listener: TcpSocket, quota: TickQuota): void {
        for (let i = 0; i < ACCEPTS_PER_TICK && this.sessions.size < MAX_CONNECTIONS && quota.operations > 0; i++) {
            try {
                quota.operations--;
                const [socket, input, output] = listener.accept();
                const transport = new TcpTransport(socket, input, output);
                this.sessions.add(new HttpSession(transport, this.lookup, { ...SESSION_LIMITS, now: this.now }));
            } catch (err) {
                const code = wasiErrorCode(err);
                // `connection-aborted` means a client left before we got to it; nothing to do.
                if (code !== 'would-block' && code !== 'connection-aborted')
                    this.log.warn(`Could not accept a connection: ${code ?? err}`);
                return;
            }
        }
    }
}
