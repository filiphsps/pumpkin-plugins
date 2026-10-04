import { randomInt } from 'node:crypto';
import * as dgram from 'node:dgram';
import * as net from 'node:net';

/**
 * Test servers listen on ports from here rather than on the ports the operating system hands out.
 * The ports the OS uses for itself start at 32768 on Linux and 49152 on macOS and Windows, so a
 * port below those is out of the way of every connection the harness and the servers themselves
 * make while a server is starting up.
 */
const FIRST_PORT = 20_000;
const LAST_PORT = 30_000;
/** How many ports to try before saying no port is free. */
const ATTEMPTS = 20;
/** Ports handed out in this process, so two servers are never sent to the same one. */
const handedOut = new Set<number>();

/** Finds a port that is free for both TCP and UDP on loopback (Bedrock uses UDP). */
export async function freePort(): Promise<number> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const port = randomInt(FIRST_PORT, LAST_PORT + 1);
        if (handedOut.has(port) || !(await free(port))) continue;
        handedOut.add(port);
        return port;
    }
    throw new Error(`No port between ${FIRST_PORT} and ${LAST_PORT} is free for both TCP and UDP`);
}

function free(port: number): Promise<boolean> {
    return tcpFree(port).then((open) => open && udpFree(port));
}

function tcpFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
}

function udpFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', () => resolve(false));
        socket.bind(port, '127.0.0.1', () => socket.close(() => resolve(true)));
    });
}
