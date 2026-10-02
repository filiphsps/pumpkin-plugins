import type { SigningMetadata } from '../sign.ts';
import { customSection } from '../wasm.ts';

/** `\0asm` + version 1, a type section `() -> ()`, and a `name` custom section. */
export function minimalWasm(): Buffer {
    return Buffer.concat([
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
        Buffer.from([0x01, 0x04, 0x01, 0x60, 0x00, 0x00]),
        customSection('name', Buffer.from('hello'))
    ]);
}

export const METADATA: SigningMetadata = {
    marketplace_url: '',
    plugin_id: 0,
    plugin_name: 'demo',
    version: '1.2.3',
    dev_id: 0,
    dev_name: 'Filiph Sandström',
    is_paid: false,
    user_id: 0,
    license_key: null,
    issued_at: '2026-01-02T03:04:05.000Z'
};

export const SEED = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
