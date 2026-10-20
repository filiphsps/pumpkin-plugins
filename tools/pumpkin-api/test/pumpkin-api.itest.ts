import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run as buildPlugin } from '../../build/src/cli.ts';

const apiRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(apiRoot, '../..');
const repositoryCacheDir = path.join(repositoryRoot, '.cache');
const fixtureSource = path.join(apiRoot, 'test/fixtures/integration-consumer');

describe.each(['static-hermes', 'quickjs'])('Pumpkin API against a real server (%s)', (engine) => {
    let fixtureRoot: string | undefined;
    let server: PumpkinInstance | undefined;

    beforeAll(async () => {
        mkdirSync(repositoryCacheDir, { recursive: true });
        fixtureRoot = mkdtempSync(path.join(repositoryCacheDir, 'pumpkin-api-integration-'));
        try {
            cpSync(fixtureSource, fixtureRoot, { recursive: true });
            const manifestPath = path.join(fixtureRoot, 'package.json');
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            manifest.pumpkinPlugin.engine = engine;
            writeFileSync(manifestPath, JSON.stringify(manifest));

            const apiLinkDir = path.join(fixtureRoot, 'node_modules/@pumpkin-plugins');
            mkdirSync(apiLinkDir, { recursive: true });
            const apiLink = path.join(apiLinkDir, 'pumpkin-api');
            symlinkSync(apiRoot, apiLink, process.platform === 'win32' ? 'junction' : 'dir');
            if (!existsSync(path.join(apiLink, 'src/index.ts'))) {
                throw new Error(`Pumpkin API source is missing through the fixture link: ${realpathSync(apiLink)}`);
            }

            const configuredHermesCache = process.env.STATIC_HERMES_CACHE_DIR;
            if (configuredHermesCache === undefined) {
                process.env.STATIC_HERMES_CACHE_DIR = path.join(repositoryCacheDir, 'hermes');
            }
            try {
                await buildPlugin([], fixtureRoot);
            } finally {
                if (configuredHermesCache === undefined) delete process.env.STATIC_HERMES_CACHE_DIR;
            }
            server = await startPumpkin({ plugins: [builtPluginPath(fixtureRoot)] });
            await server.waitForLog(/Loaded PumpkinApiTestFixture/, 20_000);
        } catch (error) {
            await server?.stop();
            rmSync(fixtureRoot, { recursive: true, force: true });
            fixtureRoot = undefined;
            throw error;
        }
    }, 180_000);

    afterAll(async () => {
        try {
            await server?.stop();
            if (server) expect(server.errors()).toEqual([]);
        } finally {
            if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    it('runs registered server-load and scheduled-task callbacks', async () => {
        const loadEvent = await server?.waitForLog(
            /PumpkinApiTestFixture server-load callback loadType=(startup|reload)/,
            10_000,
        );
        const delayedTask = await server?.waitForLog(/PumpkinApiTestFixture delayed callback count=(\d+)/, 10_000);
        const repeatingTask = await server?.waitForLog(/PumpkinApiTestFixture repeating callback count=(\d+)/, 10_000);

        expect(loadEvent).toMatch(/loadType=(startup|reload)/);
        const delayedCount = /delayed callback count=(\d+)/.exec(delayedTask ?? '')?.[1];
        const repeatingCount = /repeating callback count=(\d+)/.exec(repeatingTask ?? '')?.[1];
        expect(Number(delayedCount)).toBeGreaterThan(0);
        expect(Number(repeatingCount)).toBeGreaterThan(0);
    });

    it('cancels delayed callbacks and lets repeating callbacks cancel themselves', async () => {
        const result = await server?.waitForLog(/PumpkinApiTestFixture cancellation delayed=/, 10_000);
        expect(result).toContain('cancellation delayed=0 repeating=1');
    });

    it('dispatches command callbacks with current event and task state', async () => {
        const firstFromIndex = server?.lines.length ?? 0;
        server?.command('pumpkin-api-test');
        const firstOutput = await server?.waitForLog(/PumpkinApiTestFixture command callback=/, 10_000, firstFromIndex);
        const firstMatch =
            /command callback=(\d+) loadEvents=(\d+) delayedTasks=(\d+) loadType=(startup|reload|unknown)/.exec(
                firstOutput ?? '',
            );

        expect(firstMatch).not.toBeNull();
        expect(Number(firstMatch?.[1])).toBeGreaterThan(0);
        expect(Number(firstMatch?.[2])).toBeGreaterThan(0);
        expect(Number(firstMatch?.[3])).toBeGreaterThan(0);
        expect(firstMatch?.[4]).toMatch(/startup|reload/);

        const secondFromIndex = server?.lines.length ?? 0;
        server?.command('pumpkin-api-test');
        const secondOutput = await server?.waitForLog(
            /PumpkinApiTestFixture command callback=/,
            10_000,
            secondFromIndex,
        );
        const secondCount = /command callback=(\d+)/.exec(secondOutput ?? '')?.[1];
        expect(Number(secondCount)).toBeGreaterThan(Number(firstMatch?.[1]));
    });
});
