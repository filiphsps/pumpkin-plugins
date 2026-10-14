import { randomInt } from 'node:crypto';
import * as dgram from 'node:dgram';
import * as net from 'node:net';

/**
 * Test servers use this range, which is below common default ephemeral-port ranges (32768 on Linux
 * and 49152 on macOS and Windows). Those ranges are configurable, so this is not a guarantee that
 * the OS will never allocate one of these ports. `freePort()` probes TCP and UDP loopback binds and
 * reserves each selected port within this process; another process can still claim it before the
 * server binds it, so startup retries with fresh ports when Pumpkin reports `Address already in use`.
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

/**
 * Checks whether a UDP loopback port is available.
 *
 * @internal
 */
export function udpFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', () => socket.close(() => resolve(false)));
        socket.bind(port, '127.0.0.1', () => socket.close(() => resolve(true)));
    });
}
