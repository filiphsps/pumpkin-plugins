import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('pumpkin:plugin/ipc@0.1.0', () => ({ sendIpcMessage: host.send }));

import { ipcSend } from './ipc.ts';

beforeEach(() => vi.resetAllMocks());

describe('ipcSend', () => {
    it('returns the bytes of a successful reply', () => {
        const message = new Uint8Array([1]);
        const answer = new Uint8Array([2]);
        host.send.mockReturnValue({ tag: 'ok', val: answer });
        expect(ipcSend('OtherPlugin', message)).toBe(answer);
        expect(host.send).toHaveBeenCalledWith('OtherPlugin', message);
    });

    it('accepts an empty WIT byte result', () => {
        const message = new Uint8Array();
        host.send.mockReturnValue({ tag: 'ok', val: new Uint8Array() });

        const answer = ipcSend('OtherPlugin', message);

        expect(answer).toBeInstanceOf(Uint8Array);
        expect(answer).toHaveLength(0);
        expect(host.send).toHaveBeenCalledWith('OtherPlugin', message);
    });

    it('forwards binary messages as their original Uint8Array view', () => {
        const message = new Uint8Array([0, 128, 255, 42]).subarray(0, 3);
        host.send.mockReturnValue({ tag: 'ok', val: new Uint8Array([1]) });

        ipcSend('OtherPlugin', message);

        const sentMessage = host.send.mock.calls[0][1];
        expect(sentMessage).toBeInstanceOf(Uint8Array);
        expect(Array.from(sentMessage)).toEqual([0, 128, 255]);
    });

    it('reports recipient failures', () => {
        host.send.mockReturnValue({ tag: 'err', val: 'invalid request' });
        expect(() => ipcSend('OtherPlugin', new Uint8Array())).toThrow('invalid request');
    });

    it('preserves host failures', () => {
        const error = new Error('plugin unavailable');
        host.send.mockImplementation(() => {
            throw error;
        });
        expect(() => ipcSend('OtherPlugin', new Uint8Array())).toThrow(error);
    });
});
