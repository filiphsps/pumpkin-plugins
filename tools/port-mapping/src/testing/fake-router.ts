import * as dgram from 'node:dgram';
import * as http from 'node:http';
import type * as net from 'node:net';
import { FakeIgd, type FakeIgdOptions } from './fake-igd.ts';

/** A router on localhost: the in-memory `FakeIgd` behind real UDP and HTTP sockets. */
export interface FakeRouter {
    igd: FakeIgd;
    /** `address:port` for `router.upnp_search`. */
    ssdp: string;
    /** `address:port` for `router.nat_pmp_gateway`. */
    natPmp: string;
    close(): Promise<void>;
}

const LOOPBACK = [127, 0, 0, 1] as const;

function udpResponder(handle: (data: Uint8Array) => Uint8Array[]): Promise<dgram.Socket> {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        socket.on('message', (data, remote) => {
            for (const reply of handle(data)) socket.send(reply, remote.port, remote.address);
        });
        socket.bind(0, '127.0.0.1', () => resolve(socket));
    });
}

/** Starts the router. The fake pretends to be at the protocols' usual ports whatever the real ones are. */
export async function startFakeRouter(options: FakeIgdOptions = {}): Promise<FakeRouter> {
    let igd: FakeIgd | undefined;
    const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(request.headers)) headers[name] = String(value);
            const answer = igd?.handleHttp(
                request.method ?? 'GET',
                request.url ?? '/',
                headers,
                Buffer.concat(chunks).toString()
            );
            response.writeHead(answer?.status ?? 500, { 'Content-Type': 'text/xml' });
            response.end(answer?.body ?? '');
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    igd = new FakeIgd({ ...options, address: LOOPBACK, httpPort: (server.address() as net.AddressInfo).port });
    const router = igd;

    const ssdp = await udpResponder((data) => router.handleDatagram({ address: LOOPBACK, port: 1900 }, data));
    const natPmp = await udpResponder((data) => router.handleDatagram({ address: LOOPBACK, port: 5351 }, data));
    return {
        igd: router,
        ssdp: `127.0.0.1:${ssdp.address().port}`,
        natPmp: `127.0.0.1:${natPmp.address().port}`,
        close: async () => {
            ssdp.close();
            natPmp.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    };
}

/** Config text for UPnPumpkin that points both protocols at the router. */
export const routerConfig = (router: FakeRouter, extra = '') =>
    `[router]\nupnp_search = "${router.ssdp}"\nnat_pmp_gateway = "${router.natPmp}"\n${extra}`;
