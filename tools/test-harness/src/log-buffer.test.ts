import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LogBuffer } from './log-buffer.ts';

const options = (over = {}) => ({ timeoutMs: 200, fromIndex: 0, isOver: () => false, process: 'Proc', ...over });

describe('LogBuffer', () => {
    it('splits output into lines across chunks, drops blank lines and strips colors', () => {
        const buffer = new LogBuffer();
        const stream = new PassThrough();
        buffer.attach(stream);
        stream.write('one\ntw');
        stream.write('o\r\n\n\x1b[32mthree\x1b[0m\n');
        expect(buffer.lines).toEqual(['one', 'two', 'three']);
    });

    it('does not report a half-written line', () => {
        const buffer = new LogBuffer();
        const stream = new PassThrough();
        buffer.attach(stream);
        stream.write('incomp');
        expect(buffer.lines).toEqual([]);
    });

    it('finds lines already there and lines that arrive later', async () => {
        const buffer = new LogBuffer();
        const stream = new PassThrough();
        buffer.attach(stream);
        stream.write('hello world\n');
        expect(await buffer.waitFor(/hello/, options())).toBe('hello world');

        const later = buffer.waitFor(/ready/, options({ timeoutMs: 2000 }));
        setTimeout(() => stream.write('server ready\n'), 20);
        expect(await later).toBe('server ready');
    });

    it('can ignore earlier lines', async () => {
        const buffer = new LogBuffer();
        const stream = new PassThrough();
        buffer.attach(stream);
        stream.write('done\n');
        await expect(buffer.waitFor(/done/, options({ fromIndex: 1 }))).rejects.toThrow(/Timed out/);
    });

    it('times out with the last output attached', async () => {
        const buffer = new LogBuffer();
        const stream = new PassThrough();
        buffer.attach(stream);
        stream.write('something else\n');
        await expect(buffer.waitFor(/never/, options())).rejects.toThrow(
            /Timed out after 200 ms waiting for \/never\/[\s\S]*something else/
        );
    });

    it('stops waiting as soon as the process is over', async () => {
        const buffer = new LogBuffer();
        let over = false;
        const wait = buffer.waitFor(/never/, options({ timeoutMs: 5000, isOver: () => over }));
        over = true;
        buffer.notify();
        await expect(wait).rejects.toThrow('Proc exited before /never/ appeared');
    });
});
