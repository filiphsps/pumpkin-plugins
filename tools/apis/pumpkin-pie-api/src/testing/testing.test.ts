import { expect, it } from 'vitest';
import { PieClient } from '../client.ts';
import { PieSession } from '../session.ts';
import { FakeClock, FakeTransport } from './index.ts';

it('feeds literal fixtures through real client validation and transport failures', () => {
    const transport = new FakeTransport();
    transport.enqueue({ ok: true, value: { known: true, value: '' } });
    transport.enqueue(new Error('unavailable'));
    const client = new PieClient(transport.send);
    expect(client.getValue('empty')).toEqual({ known: true, value: '' });
    expect(() => client.ping()).toThrow('transport failed');
    expect(transport.messages.map((message) => message.request)).toEqual([
        { op: 'get_placeholder_value', id: 'empty' },
        { op: 'ping' },
    ]);
});
it('drives retry recovery without sleeps', () => {
    const clock = new FakeClock();
    const transport = new FakeTransport();
    const session = new PieSession({ send: transport.send, now: clock.now });
    session.tick();
    transport.enqueue({
        ok: true,
        ping: { protocol: 0, name: 'PumpkinPIE', version: '0.2.3', placeholders: 11, expansions: 0 },
    });
    clock.advance(1000);
    session.tick();
    expect(session.state.kind).toBe('ready');
});
