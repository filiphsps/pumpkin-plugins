import * as dgram from 'node:dgram';
import * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import { freePort } from './ports.ts';

/** The lowest port the OS hands out for itself: 32768 on Linux, 49152 on macOS and Windows. */
const FIRST_EPHEMERAL_PORT = 32_768;

const listen = (port: number) =>
    new Promise<net.Server>((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
    });

const bind = (port: number) =>
    new Promise<dgram.Socket>((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', reject);
        socket.bind(port, '127.0.0.1', () => resolve(socket));
    });

const closed = (what: net.Server | dgram.Socket) => new Promise<void>((resolve) => what.close(() => resolve()));

describe('freePort', () => {
    it('gives a port below the range the OS hands out for itself', async () => {
        // A port from that range can be taken by anything connecting while the server starts.
        expect(await freePort()).toBeLessThan(FIRST_EPHEMERAL_PORT);
    });

    it('gives a port that is free for both TCP and UDP on loopback', async () => {
        for (let round = 0; round < 5; round++) {
            const port = await freePort();
            await closed(await listen(port));
            await closed(await bind(port));
        }
    });

    it('never hands out the same port twice', async () => {
        const ports = await Promise.all(Array.from({ length: 20 }, () => freePort()));
        expect(new Set(ports).size).toBe(20);
    });
});
