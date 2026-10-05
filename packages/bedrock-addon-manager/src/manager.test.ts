import { describe, expect, it } from 'vitest';
import { FakeServer } from '../test/fake-server.ts';
import { FakeUpnpumpkin } from '../test/fake-upnpumpkin.ts';
import { makeMcpack, manifestJson } from '../test/fixtures.ts';
import { MemoryLogger } from '../test/logger.ts';
import { MemoryFiles } from '../test/memory-files.ts';
import { CONFIG_FILE } from './config/schema.ts';
import { PackManager } from './manager.ts';

const pack = (n: number) =>
    makeMcpack(manifestJson({ uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` }));

function setup(config?: string) {
    const files = new MemoryFiles();
    if (config) files.put(CONFIG_FILE, config);
    const log = new MemoryLogger();
    const server = new FakeServer();
    const upnp = new FakeUpnpumpkin();
    const clock = { now: 0 };
    const manager = new PackManager(
        files,
        log,
        () => server,
        upnp.send,
        () => clock.now
    );
    /** Moves the clock and ticks the way the game does: once per tick, here once per `step` milliseconds. */
    const wait = (ms: number, step = 500) => {
        for (let spent = 0; spent < ms; spent += step) {
            clock.now += step;
            manager.tick();
        }
    };
    return { files, log, server, manager, upnp, clock, wait };
}

const NO_FORWARDING = '[web]\nport_forwarding = false\n';
const OPEN = { kind: 'open', via: 'upnp', address: '93.184.216.34', port: 8123 } as const;

describe('PackManager', () => {
    it('creates the config and packs folder, finds packs and starts the web server', () => {
        const { files, log, server, manager } = setup();
        files.createDirectory('packs');
        files.put('packs/a.mcpack', pack(1));
        manager.start();

        expect(files.text(CONFIG_FILE)).toContain('[web]');
        expect(files.stat('packs')?.kind).toBe('directory');
        expect(manager.entries.map((e) => e.fileName)).toEqual(['a.mcpack']);
        expect(server.started).toEqual([{ bind: '0.0.0.0', port: 8123 }]);
        expect(log.of('info')).toContain('Serving packs on http://0.0.0.0:8123/packs/.');
    });

    it('creates the packs folder when it is missing', () => {
        const { files, manager } = setup();
        manager.start();
        expect(files.stat('packs')?.kind).toBe('directory');
    });

    it('warns that the default public url only works on this machine', () => {
        const { files, log, manager } = setup(NO_FORWARDING);
        files.put('packs/a.mcpack', pack(1));
        manager.start();
        expect(log.of('warn')).toEqual([
            'web.public_url is not set, so clients are told to download packs from http://127.0.0.1:8123, which only works for players on this machine. Set it to the address players can reach.'
        ]);
    });

    it('does not warn once public_url is set or when there are no packs', () => {
        const withUrl = setup('[web]\npublic_url = "https://packs.example.com"\n');
        withUrl.files.put('packs/a.mcpack', pack(1));
        withUrl.manager.start();
        expect(withUrl.log.of('warn')).toEqual([]);

        const empty = setup();
        empty.manager.start();
        expect(empty.log.of('warn')).toEqual([]);
    });

    describe('port forwarding', () => {
        const urls = (manager: PackManager) => manager.entries.map((e) => e.downloadUrl);

        it('asks UPnPumpkin to open the web port when public_url is empty and bind is 0.0.0.0', () => {
            const { files, upnp, log, manager } = setup();
            files.put('packs/a.mcpack', pack(1));
            manager.start();
            expect(upnp.requests).toEqual([
                {
                    op: 'ensure',
                    key: 'web',
                    protocol: 'tcp',
                    port: 8123,
                    externalPort: undefined,
                    description: 'Bedrock resource packs'
                }
            ]);
            expect(urls(manager)).toEqual(['http://127.0.0.1:8123/packs/a.mcpack']);
            expect(log.of('warn')).toEqual([]);
        });

        it.each([
            ['public_url is set', '[web]\npublic_url = "https://packs.example.com"\n'],
            ['bind is not 0.0.0.0', '[web]\nbind = "127.0.0.1"\n'],
            ['port_forwarding is false', NO_FORWARDING],
            ['the web server is off', '[web]\nenabled = false\n']
        ])('does not ask when %s', (_, config) => {
            const { upnp, manager, wait } = setup(config);
            manager.start();
            wait(60_000);
            manager.stop();
            expect(upnp.requests).toEqual([]);
        });

        it('uses the address UPnPumpkin opened for the download urls, and says so', () => {
            const { files, upnp, log, manager, wait } = setup();
            files.put('packs/a.mcpack', pack(1));
            manager.start();
            upnp.status = OPEN;
            wait(1000);
            expect(urls(manager)).toEqual(['http://93.184.216.34:8123/packs/a.mcpack']);
            expect(log.of('info')).toContain(
                'Opened port 8123 on the router (upnp): clients download packs from http://93.184.216.34:8123.'
            );
            expect(log.of('warn')).toEqual([]);
        });

        it('does not rescan the packs folder when the address arrives', () => {
            const { files, upnp, manager, wait } = setup();
            manager.start();
            files.put('packs/late.mcpack', pack(5));
            upnp.status = OPEN;
            wait(1000);
            expect(manager.entries).toHaveLength(0);
        });

        it('says when this machine is public already and nothing had to be opened', () => {
            const { files, upnp, log, manager } = setup();
            files.put('packs/a.mcpack', pack(1));
            upnp.status = { kind: 'open', via: 'public', address: '93.184.216.99', port: 8123 };
            manager.start();
            expect(urls(manager)).toEqual(['http://93.184.216.99:8123/packs/a.mcpack']);
            expect(log.of('info')).toContain(
                'This machine has a public address, so clients download packs from http://93.184.216.99:8123.'
            );
        });

        it('warns with the reason when the port cannot be opened, and keeps the local address', () => {
            const { files, upnp, log, manager } = setup();
            files.put('packs/a.mcpack', pack(1));
            upnp.status = { kind: 'failed', reason: 'no router answered the search' };
            manager.start();
            expect(urls(manager)).toEqual(['http://127.0.0.1:8123/packs/a.mcpack']);
            expect(log.of('warn')).toEqual([
                'Could not make port 8123 reachable from the internet: no router answered the search. Clients are told to download packs from http://127.0.0.1:8123, which only works for players on this machine. Open the port yourself and set web.public_url, or set web.port_forwarding = false.'
            ]);
        });

        it('goes back to the local address when the address is lost', () => {
            const { files, upnp, manager, wait } = setup();
            files.put('packs/a.mcpack', pack(1));
            manager.start();
            upnp.status = OPEN;
            wait(1000);
            upnp.status = { kind: 'failed', reason: 'the router went away' };
            wait(31_000, 1000);
            expect(urls(manager)).toEqual(['http://127.0.0.1:8123/packs/a.mcpack']);
        });

        it('waits before reporting that UPnPumpkin is missing, since it may load later, and recovers when it does', () => {
            const { files, upnp, log, manager, wait } = setup();
            files.put('packs/a.mcpack', pack(1));
            upnp.available = false;
            manager.start();
            wait(29_000);
            expect(log.of('warn')).toEqual([]);

            wait(2000);
            expect(log.of('warn')).toHaveLength(1);
            expect(log.of('warn')[0]).toContain('the UPnPumpkin plugin does not answer');
            expect(log.of('warn')[0]).toContain('set web.port_forwarding = false');
            wait(60_000);
            expect(log.of('warn')).toHaveLength(1);

            upnp.available = true;
            upnp.status = OPEN;
            wait(16_000, 1000);
            expect(urls(manager)).toEqual(['http://93.184.216.34:8123/packs/a.mcpack']);
        });

        it('stays quiet when UPnPumpkin turns up within the wait', () => {
            const { upnp, log, manager, wait } = setup();
            upnp.available = false;
            manager.start();
            wait(10_000);
            upnp.available = true;
            wait(20_000);
            expect(log.of('warn')).toEqual([]);
        });

        it('keeps the asked port across a reload, and moves it when the port changes', () => {
            const { files, upnp, manager, wait } = setup();
            manager.start();
            manager.reload();
            expect(upnp.ops).toEqual(['ensure']);

            files.put(CONFIG_FILE, '[web]\nport = 9000\n');
            manager.reload();
            expect(upnp.requests.map((r) => r.op)).toEqual(['ensure', 'release', 'ensure']);
            expect(upnp.requests.at(-1)).toMatchObject({ port: 9000 });
            wait(1000);
        });

        it('lets go of the port and returns to the local address when turned off', () => {
            const { files, upnp, log, manager, wait } = setup();
            files.put('packs/a.mcpack', pack(1));
            manager.start();
            upnp.status = OPEN;
            wait(1000);

            files.put(CONFIG_FILE, NO_FORWARDING);
            manager.reload();
            expect(upnp.ops.at(-1)).toBe('release');
            expect(urls(manager)).toEqual(['http://127.0.0.1:8123/packs/a.mcpack']);
            expect(log.of('warn').at(-1)).toContain('web.public_url is not set');
        });

        it('releases the port on stop, also when UPnPumpkin is gone', () => {
            const { upnp, manager } = setup();
            manager.start();
            manager.stop();
            expect(upnp.ops).toEqual(['ensure', 'release']);

            const gone = setup();
            gone.manager.start();
            gone.upnp.available = false;
            expect(() => gone.manager.stop()).not.toThrow();
        });

        it('does not send IPC when stopping during plugin unload', () => {
            const { upnp, manager } = setup();
            manager.start();
            manager.stop({ releasePort: false });

            expect(upnp.ops).toEqual(['ensure']);
        });
    });

    it('serves downloads on every tick', () => {
        const { server, manager } = setup();
        manager.start();
        manager.tick();
        manager.tick();
        expect(server.ticks).toBe(2);
    });

    it('does not look for packs on its own, only on start and reload', () => {
        const { files, manager } = setup();
        manager.start();
        files.put('packs/late.mcpack', pack(5));
        for (let i = 0; i < 500; i++) manager.tick();
        expect(manager.entries).toHaveLength(0);

        manager.reload();
        expect(manager.entries.map((e) => e.fileName)).toEqual(['late.mcpack']);
    });

    it('tells how many packs it offers on start and on reload', () => {
        const { files, log, manager } = setup();
        files.put('packs/a.mcpack', pack(1));
        manager.start();
        expect(log.of('info')).toContain(
            'Offering 1 Bedrock pack to players who join from now on (not connected to the server yet, so players are not sent them).'
        );
    });

    it('restarts the web server only when its address changed', () => {
        const { files, server, manager } = setup();
        manager.start();
        manager.reload();
        expect(server.started).toHaveLength(1);

        files.put(CONFIG_FILE, '[web]\nport = 9000\n');
        manager.reload();
        expect(server.started.at(-1)).toEqual({ bind: '0.0.0.0', port: 9000 });
        expect(server.started).toHaveLength(2);
    });

    it('stops the web server when it is turned off', () => {
        const { files, log, server, manager } = setup();
        manager.start();
        files.put(CONFIG_FILE, '[web]\nenabled = false\n');
        manager.reload();
        expect(server.stops).toBeGreaterThan(0);
        expect(log.of('info')).toContain('The web server is turned off (web.enabled = false).');
        manager.reload();
        expect(server.started).toHaveLength(1);
    });

    it('logs a web server that cannot start and keeps the plugin running', () => {
        const { log, server, manager } = setup();
        server.failStart = 'port 8123 is already in use';
        manager.start();
        expect(log.of('error')).toEqual(['Could not start the web server: port 8123 is already in use']);
        manager.tick();
        expect(manager.config.web.port).toBe(8123);
    });

    it('tries again on reload after a failed start', () => {
        const { log, server, manager } = setup();
        server.failStart = 'port 8123 is already in use';
        manager.start();
        server.failStart = undefined;
        manager.reload();
        expect(server.started).toHaveLength(1);
        expect(log.of('error')).toHaveLength(1);
    });

    it('stops the web server on stop', () => {
        const { server, manager } = setup();
        manager.start();
        const before = server.stops;
        manager.stop();
        expect(server.stops).toBe(before + 1);
    });

    it('refuses to hand out settings before it was started', () => {
        expect(() => setup().manager.config).toThrow('has not been started');
    });
});
