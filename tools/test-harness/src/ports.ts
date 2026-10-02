import * as dgram from 'node:dgram';
import * as net from 'node:net';

/** Finds a port that is free for both TCP and UDP on loopback (Bedrock uses UDP). */
export async function freePort(): Promise<number> {
    for (let attempt = 0; attempt < 20; attempt++) {
        const port = await tcpPort();
        if (await udpFree(port)) return port;
    }
    throw new Error('Could not find a port free for both TCP and UDP');
}

function tcpPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });
}

function udpFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', () => resolve(false));
        socket.bind(port, '127.0.0.1', () => socket.close(() => resolve(true)));
    });
}
