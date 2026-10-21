import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { bundlePlugin } from '../../../tools/build/src/bundle.ts';
import { ensurePumpkinWit } from '../../../tools/pumpkin-api/src/wit.mjs';
import { startPumpkin } from '../../../tools/test-harness/src/index.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const target = path.resolve(root, process.env.CARGO_TARGET_DIR ?? 'native/pumpkin-plus-plus/target');
const artifact =
    process.env.PUMPKIN_PLUS_PLUS_ARTIFACT ??
    path.join(
        target,
        `debug/${process.platform === 'win32' ? 'pumpkin_plus_plus.dll' : process.platform === 'darwin' ? 'libpumpkin_plus_plus.dylib' : 'libpumpkin_plus_plus.so'}`,
    );
const inspector = path.join(
    target,
    `debug/examples/${process.platform === 'win32' ? 'lifecycle_observer.dll' : process.platform === 'darwin' ? 'liblifecycle_observer.dylib' : 'liblifecycle_observer.so'}`,
);
const testInspector = process.env.PUMPKIN_PLUS_PLUS_INSPECTOR ?? inspector;
const output = path.join(import.meta.dirname, 'artifacts/consumer.wasm');

beforeAll(async () => {
    expect(fs.existsSync(artifact), `Build native artifact first: ${artifact}`).toBe(true);
    await bundlePlugin({
        entry: path.join(import.meta.dirname, 'consumer.ts'),
        output,
        engine: process.env.PUMPKIN_PLUS_PLUS_ENGINE === 'static-hermes' ? 'static-hermes' : 'quickjs',
        version: '0.0.0',
        witDir: ensurePumpkinWit({
            lockFile: path.join(root, 'tools/pumpkin-api/wit.lock.json'),
            cacheRoot: path.join(root, '.cache'),
        }),
        projectRoot: root,
    });
    const siblingEntry = path.join(import.meta.dirname, 'artifacts/consumer-b.ts');
    const siblingToolsImport = `${path.relative(path.dirname(siblingEntry), path.join(root, 'tools')).split(path.sep).join('/')}/`;
    fs.writeFileSync(
        siblingEntry,
        fs
            .readFileSync(path.join(import.meta.dirname, 'consumer.ts'), 'utf8')
            .replaceAll('../../../tools/', siblingToolsImport)
            .replaceAll('BridgeConsumer', 'BridgeConsumerB')
            .replace("['ppraw']", "['pprawb']")
            .replace("['ppgenerate']", "['ppgenerateb']"),
    );
    await bundlePlugin({
        entry: siblingEntry,
        output: path.join(import.meta.dirname, 'artifacts/consumer-b.wasm'),
        engine: process.env.PUMPKIN_PLUS_PLUS_ENGINE === 'static-hermes' ? 'static-hermes' : 'quickjs',
        version: '0.0.0',
        projectRoot: root,
        witDir: ensurePumpkinWit({
            lockFile: path.join(root, 'tools/pumpkin-api/wit.lock.json'),
            cacheRoot: path.join(root, '.cache'),
        }),
    });
});

it('loads exact metadata and accepts requests from an IPC caller', async () => {
    expect(fs.existsSync(artifact), `Build native artifact first: ${artifact}`).toBe(true);
    const server = await startPumpkin({ name: 'pumpkin-plus-plus-default', plugins: [artifact, output] });
    try {
        await server.waitForLog(/PP_GUEST_READY/);
        const request = async (payload: string) => {
            const from = server.lines.length;
            server.command(`ppraw ${payload}`);
            const log = await server.waitForLog(/PP_REPLY:/, 10_000, from);
            return JSON.parse(log.slice(log.indexOf('PP_REPLY:') + 9));
        };
        expect(await request('{"v":1,"op":"probe"}')).toEqual({
            v: 1,
            ok: true,
            provider: 'Pumpkin++',
            protocol: 1,
            hostRelease: '0.2.0+26.3-26.51',
            hostSourceCommit: '204a94ed895f041a845630d5a23c094705a0704e',
        });
        expect(await request('{"v":2,"op":"probe"}')).toEqual({ v: 1, ok: false, code: 'incompatible' });
        expect(await request('bytes:8193')).toEqual({ v: 1, ok: false, code: 'invalid_request' });
        expect(await request(`{"v":1,"op":"poll","operationId":"${'x'.repeat(65)}"}`)).toEqual({
            v: 1,
            ok: false,
            code: 'invalid_request',
        });
        expect(await request(`{"v":1,"op":"submit","world":"${'x'.repeat(129)}","x":0,"z":0}`)).toEqual({
            v: 1,
            ok: false,
            code: 'invalid_request',
        });
        expect(await request('bytes:[255]')).toEqual({ v: 1, ok: false, code: 'invalid_request' });
        expect(await request('{"v":1,"op":"submit","world":"absent","x":0,"z":0}')).toEqual({
            v: 1,
            ok: false,
            code: 'unknown_world',
        });
        expect(server.errors()).toEqual([]);
    } finally {
        await server.stop();
    }
});

it('binds operation IDs to the sender, bounds admission, cancels, and rejects unsafe coordinates', async () => {
    const server = await startPumpkin({
        name: 'pumpkin-plus-plus-admission',
        plugins: [artifact, testInspector, output, path.join(import.meta.dirname, 'artifacts/consumer-b.wasm')],
    });
    try {
        await server.waitForLog(/PP_GUEST_READY/);
        const request = async (value: unknown) => {
            const from = server.lines.length;
            server.command(`ppraw ${JSON.stringify(value)}`);
            const log = await server.waitForLog(/PP_REPLY:/, 10_000, from);
            return JSON.parse(log.slice(log.indexOf('PP_REPLY:') + 9));
        };
        expect(await request({ v: 1, op: 'submit', world: 'absent', x: 0, z: 0 })).toEqual({
            v: 1,
            ok: false,
            code: 'unknown_world',
        });
        expect(await request({ v: 1, op: 'submit', world: 'world', x: 2147483647, z: -2147483648 })).toEqual({
            v: 1,
            ok: false,
            code: 'invalid_request',
        });
        expect(await request({ v: 1, op: 'submit', world: 'world', x: 0, z: 0, caller: 'forged' })).toEqual({
            v: 1,
            ok: false,
            code: 'invalid_request',
        });
        const job = await request({ v: 1, op: 'submit', world: 'world', x: -9000, z: 9010 });
        expect(job).toMatchObject({ v: 1, ok: true, state: 'queued' });
        const inspectTicket = async () => {
            const from = server.lines.length;
            server.command('ppraw inspect:{"world":"world","x":-9000,"z":9010}');
            const log = await server.waitForLog(/PP_REPLY:/, 10_000, from);
            return JSON.parse(log.slice(log.indexOf('PP_REPLY:') + 9));
        };
        await expect.poll(inspectTicket, { timeout: 10_000 }).toMatchObject({ levels: [43] });
        const stolenFrom = server.lines.length;
        server.command(`pprawb ${JSON.stringify({ v: 1, op: 'poll', operationId: job.operationId })}`);
        const stolen = await server.waitForLog(/PP_REPLY:/, 10_000, stolenFrom);
        expect(JSON.parse(stolen.slice(stolen.indexOf('PP_REPLY:') + 9))).toEqual({
            v: 1,
            ok: false,
            code: 'not_found',
        });
        expect(await request({ v: 1, op: 'cancel', operationId: job.operationId })).toEqual({
            v: 1,
            ok: true,
            operationId: job.operationId,
            state: 'cancelled',
        });
        expect(await inspectTicket()).toMatchObject({ levels: [], loaded: false });
        expect(await request({ v: 1, op: 'poll', operationId: job.operationId })).toEqual({
            v: 1,
            ok: false,
            operationId: job.operationId,
            code: 'cancelled',
        });
        expect(await request({ v: 1, op: 'poll', operationId: 'unknown' })).toEqual({
            v: 1,
            ok: false,
            code: 'not_found',
        });
        const burst = Array.from({ length: 40 }, () => ({ v: 1, op: 'submit', world: 'world', x: -8000, z: 8100 }));
        const from = server.lines.length;
        server.command(`ppraw batch:${JSON.stringify(burst)}`);
        const burstLog = await server.waitForLog(/PP_REPLY:/, 10_000, from);
        const responses = JSON.parse(burstLog.slice(burstLog.indexOf('PP_REPLY:') + 9));
        expect(responses.some((response) => response.code === 'busy')).toBe(true);
        for (const response of responses.filter((response) => response.ok)) {
            expect(await request({ v: 1, op: 'cancel', operationId: response.operationId })).toMatchObject({
                ok: true,
                state: 'cancelled',
            });
        }
        expect(server.errors()).toEqual([]);
    } finally {
        await server.stop();
    }
});

it('prepares custom generated air, shares one ticket, releases it, reloads saved air, and drains on native unload', async () => {
    const server = await startPumpkin({
        name: 'pumpkin-plus-plus-generation',
        plugins: [artifact, testInspector, output],
        files: { 'plugins/data/Pumpkin++/config.json': JSON.stringify({ leaseMs: 500 }) },
    });
    try {
        await server.waitForLog(/PP_GUEST_READY/);
        server.command('ppgenerate');
        const submit = await server.waitForLog(/PP_SUBMITTED:/);
        await server.waitForLog(/PP_GENERATED_AIR_READY:/, 60_000);
        await server.waitForLog(/PP_SAVED_AIR_READY/, 60_000);
        await server.waitForLog(/PP_LEASE_EXPIRED:/);
        await server.waitForLog(/PP_WORLD_UNLOADED/);
        expect(server.lines.indexOf(submit)).toBeLessThan(
            server.lines.findIndex((line) => line.includes('PP_GENERATOR:')),
        );
        const admissionFrom = server.lines.length;
        server.command('ppraw {"v":1,"op":"submit","world":"world","x":-6001,"z":6001}');
        await server.waitForLog(/PP_REPLY:.*operationId/, 10_000, admissionFrom);
        const _activeFrom = server.lines.length;
        const inspectAdmission = async () => {
            const from = server.lines.length;
            server.command('ppraw inspect:{"world":"world","x":-6001,"z":6001}');
            const log = await server.waitForLog(/PP_REPLY:.*"levels"/, 10_000, from);
            return JSON.parse(log.slice(log.indexOf('PP_REPLY:') + 9));
        };
        await expect.poll(inspectAdmission, { timeout: 10_000 }).toMatchObject({ levels: [43] });
        const from = server.lines.length;
        server.command('plugin unload Pumpkin++');
        await server.waitForLog(/bridge drained: jobs=0 tickets=0 observers=0/, 10_000, from);
        await server.waitForLog(/bridge worker joined/, 10_000, from);
        const releasedFrom = server.lines.length;
        server.command('ppraw inspect:{"world":"world","x":-6001,"z":6001}');
        await server.waitForLog(/PP_REPLY:.*"levels":\[\]/, 10_000, releasedFrom);
        expect(server.errors()).toEqual([]);
    } finally {
        await server.stop();
    }
});

it('expires queued deadlines, removes terminal history, and leaves no host ticket', async () => {
    const server = await startPumpkin({
        name: 'pumpkin-plus-plus-deadline',
        plugins: [artifact, testInspector, output],
        files: {
            'plugins/data/Pumpkin++/config.json': JSON.stringify({
                deadlineMs: 1,
                terminalRetentionMs: 300,
            }),
        },
    });
    try {
        await server.waitForLog(/PP_GUEST_READY/);
        const request = async (payload: string) => {
            const from = server.lines.length;
            server.command(`ppraw ${payload}`);
            const log = await server.waitForLog(/PP_REPLY:/, 10_000, from);
            return JSON.parse(log.slice(log.indexOf('PP_REPLY:') + 9));
        };
        const job = await request(JSON.stringify({ v: 1, op: 'submit', world: 'world', x: -6000, z: 6000 }));
        expect(job).toMatchObject({ ok: true, state: 'queued' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(await request(JSON.stringify({ v: 1, op: 'poll', operationId: job.operationId }))).toEqual({
            v: 1,
            ok: false,
            operationId: job.operationId,
            code: 'timeout',
        });
        expect(await request(JSON.stringify({ v: 1, op: 'cancel', operationId: job.operationId }))).toEqual({
            v: 1,
            ok: false,
            operationId: job.operationId,
            code: 'timeout',
        });
        await expect
            .poll(() => request(JSON.stringify({ v: 1, op: 'poll', operationId: job.operationId })), { timeout: 2000 })
            .toEqual({ v: 1, ok: false, code: 'not_found' });
        expect(await request('inspect:{"world":"world","x":-6000,"z":6000}')).toMatchObject({ levels: [] });
    } finally {
        await server.stop();
    }
});

it('releases a disappeared caller ticket and joins the worker during shutdown with pending work', async () => {
    const server = await startPumpkin({
        name: 'pumpkin-plus-plus-lifecycle',
        plugins: [artifact, testInspector, output, path.join(import.meta.dirname, 'artifacts/consumer-b.wasm')],
    });
    const request = async (command: string, payload: string) => {
        const from = server.lines.length;
        server.command(`${command} ${payload}`);
        const log = await server.waitForLog(/PP_REPLY:/, 10000, from);
        return JSON.parse(log.slice(log.indexOf('PP_REPLY:') + 9));
    };
    try {
        await server.waitForLog(/PP_GUEST_READY/);
        expect(await request('ppraw', '{"v":1,"op":"submit","world":"world","x":-7001,"z":7001}')).toMatchObject({
            ok: true,
        });
        await expect
            .poll(() => request('pprawb', 'inspect:{"world":"world","x":-7001,"z":7001}'), { timeout: 2000 })
            .toMatchObject({ levels: [43] });
        server.command('plugin unload BridgeConsumer');
        await server.waitForLog(/Plugin BridgeConsumer unloaded successfully/);
        await expect
            .poll(() => request('pprawb', 'inspect:{"world":"world","x":-7001,"z":7001}'), { timeout: 2000 })
            .toMatchObject({ levels: [] });
        expect(await request('pprawb', '{"v":1,"op":"submit","world":"world","x":-7002,"z":7002}')).toMatchObject({
            ok: true,
        });
        await expect
            .poll(() => request('pprawb', 'inspect:{"world":"world","x":-7002,"z":7002}'), { timeout: 2000 })
            .toMatchObject({ levels: [43] });
    } finally {
        await server.stop();
    }
    expect(server.logs()).toContain('bridge drained: jobs=0 tickets=0 observers=0');
    expect(server.logs()).toContain('bridge worker joined');
    expect(server.logs()).toContain('Completed worlds');
    expect(server.errors()).toEqual([]);
});
