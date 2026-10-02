import { strFromU8, strToU8 } from 'fflate';
import type { Endpoint, Ipv4 } from '../ipv4.ts';
import { sameIpv4 } from '../ipv4.ts';
import type { Connection, Datagram, DatagramSocket, Dial, Network } from '../network.ts';
import { type Steps, Task } from '../task.ts';
import type { FakeIgd } from './fake-igd.ts';

class FakeSocket implements DatagramSocket {
    closed = false;
    readonly inbox: Datagram[] = [];

    constructor(private readonly net: FakeNetwork) {}

    send(to: Endpoint, data: Uint8Array): void {
        this.net.sent.push({ to, data });
        for (const router of this.net.routers) {
            for (const reply of router.handleDatagram(to, data)) {
                this.inbox.push({ from: { address: router.address, port: to.port }, data: reply });
            }
        }
    }

    receive(): Datagram | undefined {
        return this.inbox.shift();
    }

    close(): void {
        this.closed = true;
    }
}

class FakeConnection implements Connection {
    closed = false;
    private request = new Uint8Array(0);
    private response: Uint8Array | undefined;
    private delivered = false;

    constructor(
        readonly localAddress: Ipv4,
        private readonly router: FakeIgd
    ) {}

    read(): Uint8Array | null | 'closed' {
        if (!this.response) return null;
        if (!this.delivered) {
            this.delivered = true;
            return this.response;
        }
        return 'closed';
    }

    writable(): number {
        return 1 << 16;
    }

    write(bytes: Uint8Array): void {
        const all = new Uint8Array(this.request.length + bytes.length);
        all.set(this.request);
        all.set(bytes, this.request.length);
        this.request = all;
        this.answerWhenComplete();
    }

    close(): void {
        this.closed = true;
    }

    private answerWhenComplete(): void {
        const text = strFromU8(this.request);
        const end = text.indexOf('\r\n\r\n');
        if (end === -1) return;
        const [requestLine = '', ...lines] = text.slice(0, end).split('\r\n');
        const headers: Record<string, string> = {};
        for (const line of lines)
            headers[line.slice(0, line.indexOf(':')).toLowerCase()] = line.slice(line.indexOf(':') + 1).trim();
        const body = text.slice(end + 4);
        if (body.length < Number(headers['content-length'] ?? 0)) return;
        const [method = '', path = ''] = requestLine.split(' ');
        const { status, body: out } = this.router.handleHttp(method, path, headers, body);
        const payload = strToU8(out);
        const head = strToU8(
            `HTTP/1.1 ${status} X\r\nContent-Type: text/xml\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`
        );
        this.response = new Uint8Array(head.length + payload.length);
        this.response.set(head);
        this.response.set(payload, head.length);
    }
}

/**
 * A network in memory for tests: a clock you move by hand and routers (`FakeIgd`) that answer on it.
 * Datagrams reach every router; connections reach the router whose address and HTTP port match.
 */
export class FakeNetwork implements Network {
    time = 0;
    /** This machine's address. Undefined means no route. */
    local: Ipv4 | undefined = [192, 168, 1, 50];
    readonly sockets: FakeSocket[] = [];
    readonly connections: FakeConnection[] = [];
    readonly sent: { to: Endpoint; data: Uint8Array }[] = [];

    /** Creates a network with the given routers. */
    constructor(readonly routers: FakeIgd[] = []) {}

    /** How far the clock moves each time it is read, for code that waits on it in a loop. */
    autoAdvanceMs = 0;

    now(): number {
        const time = this.time;
        this.time += this.autoAdvanceMs;
        return time;
    }

    localAddress(): Ipv4 | undefined {
        return this.local;
    }

    openDatagram(): DatagramSocket {
        const socket = new FakeSocket(this);
        this.sockets.push(socket);
        return socket;
    }

    dial(to: Endpoint): Dial {
        const router = this.routers.find(
            (r) => sameIpv4(r.address, to.address) && (r.httpPort === to.port || (to.port === 80 && r.hasWebInterface))
        );
        const local = this.local ?? [127, 0, 0, 1];
        return {
            poll: () => {
                if (!router) throw new Error('connection refused');
                const connection = new FakeConnection(local, router);
                this.connections.push(connection);
                return connection;
            },
            abort: () => {}
        };
    }

    /** Sockets and connections that were opened and never closed. */
    get leaks(): number {
        return this.sockets.filter((s) => !s.closed).length + this.connections.filter((c) => !c.closed).length;
    }
}

/**
 * Runs steps to the end on a fake network, moving its clock forward between steps.
 * @param stepMs - How far the clock moves after each step.
 * @param limitMs - Gives up after this much fake time.
 * @throws {Error} What the steps threw, or a timeout.
 */
export function runSteps<T>(net: FakeNetwork, steps: Steps<T>, stepMs = 10, limitMs = 120_000): T {
    const task = new Task(steps);
    for (const start = net.time; net.time - start <= limitMs; net.time += stepMs) {
        const state = task.poll();
        if (state.state === 'done') return state.value;
        if (state.state === 'failed') throw state.error;
    }
    task.cancel();
    throw new Error('the steps did not finish');
}
