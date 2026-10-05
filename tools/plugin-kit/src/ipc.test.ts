import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('pumpkin:plugin/ipc@0.1.0', () => ({ sendIpcMessage: host.send }));

import { ipcSend } from './ipc.ts';

beforeEach(() => vi.resetAllMocks());

describe('ipcSend', () => {
    it.each(['bare', 'tagged'])('accepts a %s successful reply', (shape) => {
        const message = new Uint8Array([1]);
        const answer = new Uint8Array([2]);
        host.send.mockReturnValue(shape === 'bare' ? answer : { tag: 'ok', val: answer });
        expect(ipcSend('OtherPlugin', message)).toBe(answer);
        expect(host.send).toHaveBeenCalledWith('OtherPlugin', message);
    });

    it('reports recipient failures', () => {
        host.send.mockReturnValue({ tag: 'err', val: 'invalid request' });
        expect(() => ipcSend('OtherPlugin', new Uint8Array())).toThrow('invalid request');
    });

    it.each([undefined, null, {}, { tag: 'ok', val: 'not bytes' }])(
        'rejects missing or malformed replies: %j',
        (answer) => {
            host.send.mockReturnValue(answer);
            expect(() => ipcSend('OtherPlugin', new Uint8Array())).toThrow('OtherPlugin did not answer');
        }
    );

    it('preserves host failures', () => {
        const error = new Error('plugin unavailable');
        host.send.mockImplementation(() => {
            throw error;
        });
        expect(() => ipcSend('OtherPlugin', new Uint8Array())).toThrow(error);
    });
});
