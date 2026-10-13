import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { startPumpkin } from '@pumpkin-plugins/test-harness';
import { expect, it } from 'vitest';

it('returns mutated and replacement event payloads to Pumpkin', async () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-event-results-'));
    const apiRoot = path.dirname(createRequire(import.meta.url).resolve('@pumpkin-plugins/pumpkin-api/package.json'));
    let server: Awaited<ReturnType<typeof startPumpkin>> | undefined;
    try {
        fs.mkdirSync(path.join(directory, 'node_modules/@pumpkin-plugins'), { recursive: true });
        fs.symlinkSync(apiRoot, path.join(directory, 'node_modules/@pumpkin-plugins/pumpkin-api'), 'dir');
        fs.writeFileSync(
            path.join(directory, 'package.json'),
            JSON.stringify({
                name: 'event-results',
                version: '0.0.0',
                pumpkinPlugin: { entry: 'plugin.ts', output: 'plugin.wasm', engine: 'static-hermes', wasi: [] }
            })
        );
        fs.writeFileSync(
            path.join(directory, 'plugin.ts'),
            `
            import { Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';
            import * as logging from 'pumpkin:plugin/logging@0.1.0';
            export * from '@pumpkin-plugins/pumpkin-api';
            class EventResults extends Plugin {
                metadata() { return { name: 'EventResults', version: '0.0.0', authors: [], description: '', dependencies: [], permissions: [] }; }
                onLoad(context) {
                    this.registerEvent(context, 'server-command-event', (_server, event) => {
                        if (event.command === 'hermes-mutate') {
                            event.cancelled = true;
                            logging.log('info', 'mutated event payload');
                        }
                        if (event.command === 'hermes-replace') {
                            logging.log('info', 'replaced event payload');
                            return { command: event.command, cancelled: true };
                        }
                    });
                    logging.log('info', 'EventResults ready');
                }
            }
            registerPlugin(new EventResults());
        `
        );
        execFileSync(process.execPath, [path.join(root, 'tools/build/dist/cli.js')], {
            cwd: directory,
            env: { ...process.env, STATIC_HERMES_CACHE_DIR: path.join(root, '.cache/hermes'), PUMPKIN_DEV_MODE: '1' },
            stdio: 'pipe'
        });
        server = await startPumpkin({ plugins: [path.join(directory, 'plugin.wasm')] });
        await server.waitForLog(/EventResults ready/);
        for (const [command, expectedLog] of [
            ['hermes-mutate', 'mutated event payload'],
            ['hermes-replace', 'replaced event payload']
        ]) {
            const fromIndex = server.lines.length;
            server.command(command);
            // Pumpkin applies `cancelled` but dispatches the original console input string.
            server.command('list');
            await server.waitForLog(/There are.*players online/, 10_000, fromIndex);
            const output = server.lines.slice(fromIndex).join('\n');
            expect(output).toContain(expectedLog);
            expect(output).not.toContain(`Unknown command: ${command}`);
        }
        expect(server.errors()).toEqual([]);
    } finally {
        await server?.stop();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}, 300_000);
