import { subscribeDuration } from 'wasi:clocks/monotonic-clock@0.2.3';
import { instanceNetwork } from 'wasi:sockets/instance-network@0.2.3';
import { createTcpSocket } from 'wasi:sockets/tcp-create-socket@0.2.3';
import { createUdpSocket } from 'wasi:sockets/udp-create-socket@0.2.3';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import type { Sockets } from './wasi-network.ts';

/**
 * The sockets WASI gives a plugin. It lives apart from the adapter so that the adapter imports no
 * `wasi:` module at runtime, which is what lets its tests run outside a WebAssembly host.
 */
export const wasiSockets: Sockets = {
    instance: () => instanceNetwork(),
    tcp: () => createTcpSocket('ipv4'),
    udp: () => createUdpSocket('ipv4'),
    pause: (ms) => {
        const timer = subscribeDuration(BigInt(Math.max(0, Math.ceil(ms))) * 1_000_000n);
        try {
            timer.block();
        } finally {
            disposeWasiResource(timer);
        }
    },
};
