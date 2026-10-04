import { instanceNetwork } from 'wasi:sockets/instance-network@0.2.3';
import { createTcpSocket } from 'wasi:sockets/tcp-create-socket@0.2.3';
import { createUdpSocket } from 'wasi:sockets/udp-create-socket@0.2.3';
import type { Sockets } from './wasi-network.ts';

/**
 * The sockets WASI gives a plugin. It lives apart from the adapter so that the adapter imports no
 * `wasi:` module at runtime, which is what lets its tests run outside a WebAssembly host.
 */
export const wasiSockets: Sockets = {
    instance: () => instanceNetwork(),
    tcp: () => createTcpSocket('ipv4'),
    udp: () => createUdpSocket('ipv4')
};
