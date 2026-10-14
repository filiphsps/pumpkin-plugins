import { defaultValues } from '@pumpkin-plugins/config';
import { describe, expect, it, vi } from 'vitest';
import { configSchema, validateConfig } from './config.ts';
import type { ApplyResult, PlayerSnapshot, RenderedLine } from './model.ts';
import { type TabDisplayHost, TabDisplayService, type TabPlaceholderResolver } from './service.ts';

class FakeHost implements TabDisplayHost {
    readonly names = new Map<string, string | undefined>();
    readonly orders = new Map<string, number>();
    readonly headers = new Map<string, { header: readonly RenderedLine[]; footer: readonly RenderedLine[] }>();
    entryFailuresRemaining = 0;
    resetCount = 0;
    resetFailuresRemaining = 0;
    players: readonly PlayerSnapshot[];
    constructor(players: readonly PlayerSnapshot[]) {
        this.players = players;
    }
    snapshotPlayers(_limit: number): readonly PlayerSnapshot[] {
        return this.players;
    }
    setEntryName(uuid: string, value: RenderedLine | undefined): ApplyResult {
        if (this.entryFailuresRemaining > 0) {
            this.entryFailuresRemaining -= 1;
            return { kind: 'failed', error: 'Could not apply row name' };
        }
        this.names.set(uuid, value?.text);
        return { kind: 'applied' };
    }
    setOrder(uuid: string, order: number): ApplyResult {
        this.orders.set(uuid, order);
        return { kind: 'applied' };
    }
    setHeaderFooter(uuid: string, header: readonly RenderedLine[], footer: readonly RenderedLine[]): ApplyResult {
        this.headers.set(uuid, { header, footer });
        return { kind: 'applied' };
    }
    resetOwned(uuid: string): void {
        this.resetCount += 1;
        if (this.resetFailuresRemaining > 0) {
            this.resetFailuresRemaining -= 1;
            throw new Error('Reset failed');
        }
        this.names.delete(uuid);
        this.orders.delete(uuid);
        this.headers.delete(uuid);
    }
}

function baseConfig() {
    const config = structuredClone(defaultValues(configSchema));
    config.general.refresh_ticks = 1;
    config.header.lines = [{ text: 'Hi %player_name%' }];
    config.footer.lines = [];
    config.entry.text = '%player_name%';
    return config;
}

function validConfig(value: unknown) {
    const result = validateConfig(value);
    if (result.kind !== 'valid') throw new Error('Test config was invalid');
    return result.config;
}

const viewers: readonly PlayerSnapshot[] = [
    { uuid: 'uuid-a', name: 'Alex', edition: 'java', javaVersion: 'v-26-3', ping: 20 },
    { uuid: 'uuid-b', name: 'Bea', edition: 'java', javaVersion: 'v-26-3', ping: 30 },
];

describe('TabDisplayService', () => {
    it('uses viewer context for headers and subject context for a shared row template', () => {
        const host = new FakeHost(viewers);
        const resolver: TabPlaceholderResolver = {
            resolveBatch: (requests) =>
                requests.map(({ text, viewer }) => ({
                    text: text.replaceAll('%player_name%', viewer ?? 'server'),
                    unresolved: [],
                })),
        };
        const service = new TabDisplayService({ host, resolver, now: () => 0, config: validConfig(baseConfig()) });
        service.tick();
        expect(host.headers.get('uuid-a')?.header[0]?.text).toBe('Hi Alex');
        expect(host.headers.get('uuid-b')?.header[0]?.text).toBe('Hi Bea');
        expect(host.names).toEqual(
            new Map([
                ['uuid-a', 'Alex'],
                ['uuid-b', 'Bea'],
            ]),
        );
        expect(host.orders).toEqual(new Map());
        expect(service.status().javaVersions).toEqual(['v-26-3']);
        expect(service.inspect('uuid-a')).toEqual({
            uuid: 'uuid-a',
            name: 'Alex',
            edition: 'java',
            javaVersion: 'v-26-3',
            ping: 20,
            placeholderIds: ['player_name'],
        });
    });

    it('does not call Java row setters for Bedrock and reports unsupported Java versions', () => {
        const host = new FakeHost([
            { uuid: 'bedrock', name: 'Bedrock', edition: 'bedrock' },
            { uuid: 'old-java', name: 'OldJava', edition: 'java', javaVersion: 'v-1-21-2' },
        ]);
        const setName = vi.spyOn(host, 'setEntryName');
        const setHeaderFooter = vi.spyOn(host, 'setHeaderFooter');
        const service = new TabDisplayService({
            host,
            resolver: { resolveBatch: (requests) => requests.map(({ text }) => ({ text, unresolved: [] })) },
            now: () => 0,
            config: validConfig(baseConfig()),
        });

        service.tick();

        expect(setName).toHaveBeenCalledTimes(1);
        expect(setName).toHaveBeenCalledWith('old-java', expect.anything());
        expect(setHeaderFooter).toHaveBeenCalledTimes(1);
        expect(setHeaderFooter).toHaveBeenCalledWith('old-java', expect.anything(), expect.anything());
        expect(service.status().java).toEqual({
            kind: 'unsupported',
            reason: 'Java tab display calls are gated to v-26-3; live client behavior is unverified (connected: v-1-21-2)',
        });
        expect(service.status().lastFailure).toBeUndefined();
    });

    it('resolves entry placeholders only for Java players', () => {
        const host = new FakeHost([
            { uuid: 'java', name: 'Java', edition: 'java', javaVersion: 'v-26-3' },
            { uuid: 'bedrock', name: 'Bedrock', edition: 'bedrock' },
        ]);
        const requests: { text: string; viewer?: string }[] = [];
        const service = new TabDisplayService({
            host,
            resolver: {
                resolveBatch: (batch) => {
                    requests.push(...batch);
                    return batch.map(({ text, viewer }) => ({
                        text: text.replaceAll('%player_name%', viewer ?? 'server'),
                        unresolved: [],
                    }));
                },
            },
            now: () => 0,
            config: validConfig(baseConfig()),
        });

        service.tick();

        expect(requests).toHaveLength(2);
        expect(requests.every(({ viewer }) => viewer === 'Java')).toBe(true);
        expect(requests.map(({ text }) => text)).toEqual(expect.arrayContaining(['%player_name%', 'Hi %player_name%']));
        expect(host.names.get('java')).toBe('Java');
        expect(host.names.has('bedrock')).toBe(false);
        expect(host.headers.get('java')?.header[0]?.text).toBe('Hi Java');
        expect(host.headers.has('bedrock')).toBe(false);
    });

    it('restores row names when a valid reload disables entry formatting', () => {
        const host = new FakeHost(viewers);
        const service = new TabDisplayService({
            host,
            resolver: { resolveBatch: (requests) => requests.map(({ text }) => ({ text, unresolved: [] })) },
            now: () => 0,
            config: validConfig(baseConfig()),
        });
        service.tick();

        const replacement = baseConfig();
        replacement.entry.enabled = false;
        expect(service.setConfig(replacement).kind).toBe('applied');
        service.tick();

        expect(host.names.get('uuid-a')).toBeUndefined();
        expect(host.names.get('uuid-b')).toBeUndefined();
    });

    it('does not apply a partial generation when work exceeds the per-tick budget', () => {
        const many = Array.from({ length: 300 }, (_, index) => ({
            uuid: String(index).padStart(3, '0'),
            name: `Player${index}`,
            edition: 'java' as const,
            ping: index,
        }));
        const host = new FakeHost(many);
        const config = baseConfig();
        config.header.lines = [];
        const resolver: TabPlaceholderResolver = {
            resolveBatch: (requests) =>
                requests.map(({ text }) => ({ text: text.replace('%player_name%', 'resolved'), unresolved: [] })),
        };
        const service = new TabDisplayService({ host, resolver, now: () => 0, config: validConfig(config) });
        service.tick();
        expect(host.names.size).toBe(0);
        service.tick();
        expect(host.names.size).toBe(300);
    });

    it('does not apply a truncated roster when the configured player limit is exceeded', () => {
        const host = new FakeHost(viewers);
        const config = baseConfig();
        config.general.max_players = 1;
        const service = new TabDisplayService({
            host,
            resolver: { resolveBatch: (requests) => requests.map(({ text }) => ({ text, unresolved: [] })) },
            now: () => 0,
            config: validConfig(config),
        });

        service.tick();

        expect(host.names.size).toBe(0);
        expect(host.headers.size).toBe(0);
        expect(host.orders.size).toBe(0);
        expect(service.status().lastFailure).toContain('general.max_players');
    });

    it('rejects mismatched placeholder batches without applying shifted player data', () => {
        const host = new FakeHost(viewers);
        const resolver: TabPlaceholderResolver = { resolveBatch: () => [{ text: 'wrong', unresolved: [] }] };
        const service = new TabDisplayService({ host, resolver, now: () => 0, config: validConfig(baseConfig()) });
        service.tick();
        expect(host.names).toEqual(
            new Map([
                ['uuid-a', '%player_name%'],
                ['uuid-b', '%player_name%'],
            ]),
        );
        expect([...host.names.values()]).not.toContain('wrong');
        expect(service.status().lastFailure).toMatch(/batch/i);
    });

    it('reports the actual display update error instead of labeling it as an output limit', () => {
        const host = new FakeHost(viewers);
        vi.spyOn(host, 'setHeaderFooter').mockImplementationOnce(() => {
            throw new Error('Cannot use a disposed or transferred resource');
        });
        const warnings: string[] = [];
        const service = new TabDisplayService({
            host,
            resolver: { resolveBatch: (requests) => requests.map(({ text }) => ({ text, unresolved: [] })) },
            now: () => 0,
            config: validConfig(baseConfig()),
            log: (message) => warnings.push(message),
        });

        service.tick();

        expect(warnings).toEqual(['Display update failed: Error: Cannot use a disposed or transferred resource']);
    });

    it('does not repeat setters for stable unsupported capabilities', () => {
        const host = new FakeHost([viewers[0]!]);
        const unsupported = { kind: 'unsupported', reason: 'Not available for this client' } as const;
        const setEntryName = vi.spyOn(host, 'setEntryName').mockReturnValue(unsupported);
        const setHeaderFooter = vi.spyOn(host, 'setHeaderFooter').mockReturnValue(unsupported);
        const service = new TabDisplayService({
            host,
            resolver: { resolveBatch: (requests) => requests.map(({ text }) => ({ text, unresolved: [] })) },
            now: () => 0,
            config: validConfig(baseConfig()),
        });

        service.tick();
        service.tick();

        expect(setEntryName).toHaveBeenCalledTimes(1);
        expect(setHeaderFooter).toHaveBeenCalledTimes(1);
    });

    it.each(['version change', 'disconnect', 'disable', 'shutdown'] as const)(
        'retries unsupported setters after %s invalidates the player capability',
        (invalidation) => {
            const player = { ...viewers[0]!, javaVersion: 'v-1-21-1' };
            const host = new FakeHost([player]);
            const setEntryName = vi.spyOn(host, 'setEntryName').mockReturnValue({
                kind: 'unsupported',
                reason: 'Not available for this client',
            });
            const config = baseConfig();
            const service = new TabDisplayService({
                host,
                resolver: { resolveBatch: (requests) => requests.map(({ text }) => ({ text, unresolved: [] })) },
                now: () => 0,
                config: validConfig(config),
            });

            service.tick();
            service.tick();
            expect(setEntryName).toHaveBeenCalledTimes(1);

            if (invalidation === 'version change') {
                host.players = [{ ...player, javaVersion: 'v-26-3' }];
                service.tick();
            } else if (invalidation === 'disconnect') {
                host.players = [];
                service.tick();
                host.players = [player];
                service.tick();
            } else if (invalidation === 'disable') {
                config.general.enabled = false;
                service.setConfig(config);
                service.tick();
                config.general.enabled = true;
                service.setConfig(config);
                service.tick();
            } else {
                service.shutdown();
                service.tick();
            }

            expect(setEntryName).toHaveBeenCalledTimes(2);
        },
    );

    it('retries a failed row-name update when the next tick renders the same output', () => {
        const host = new FakeHost(viewers);
        host.entryFailuresRemaining = 1;
        const service = new TabDisplayService({
            host,
            resolver: { resolveBatch: (requests) => requests.map(({ text }) => ({ text, unresolved: [] })) },
            now: () => 0,
            config: validConfig(baseConfig()),
        });

        service.tick();

        expect(host.names.has('uuid-a')).toBe(false);
        expect(service.status().lastFailure).toBe('Could not apply row name');

        service.tick();

        expect(host.names.get('uuid-a')).toBe('%player_name%');
        expect(service.status().lastFailure).toBeUndefined();
    });

    it('keeps the last valid generation for 30 seconds during provider outages', () => {
        const host = new FakeHost(viewers);
        let available = true;
        const resolver: TabPlaceholderResolver = {
            resolveBatch: (requests) => {
                if (!available) throw new Error('provider unavailable');
                return requests.map(({ text, viewer }) => ({
                    text: text.replace('%player_name%', viewer ?? 'server'),
                    unresolved: [],
                }));
            },
        };
        let time = 0;
        const service = new TabDisplayService({ host, resolver, now: () => time, config: validConfig(baseConfig()) });
        service.tick();
        expect(host.names.get('uuid-a')).toBe('Alex');
        available = false;
        service.tick();
        expect(host.names.get('uuid-a')).toBe('Alex');
        time = 30_001;
        service.tick();
        expect(host.names.get('uuid-a')).toBe('%player_name%');
    });

    it('restores plugin-owned fields when disabled and clears disconnected snapshots', () => {
        const host = new FakeHost(viewers);
        const config = baseConfig();
        const service = new TabDisplayService({
            host,
            resolver: { resolveBatch: (requests) => requests.map(({ text }) => ({ text, unresolved: [] })) },
            now: () => 0,
            config: validConfig(config),
        });
        service.tick();
        config.general.enabled = false;
        const result = service.setConfig(config);
        expect(result.kind).toBe('applied');
        service.tick();
        expect(host.resetCount).toBe(2);
    });

    it('retries failed resets on later ticks while the display remains disabled', () => {
        const host = new FakeHost([{ uuid: 'uuid-a', name: 'Alex', edition: 'java', javaVersion: 'v-26-3', ping: 20 }]);
        const config = baseConfig();
        const service = new TabDisplayService({
            host,
            resolver: {
                resolveBatch: (requests) =>
                    requests.map(({ text, viewer }) => ({
                        text: text.replaceAll('%player_name%', viewer ?? 'server'),
                        unresolved: [],
                    })),
            },
            now: () => 0,
            config: validConfig(config),
        });
        service.tick();
        host.resetFailuresRemaining = 1;
        config.general.enabled = false;
        expect(service.setConfig(config).kind).toBe('applied');

        service.tick();

        expect(host.names.get('uuid-a')).toBe('Alex');
        expect(host.headers.has('uuid-a')).toBe(true);
        expect(service.status().lastFailure).toBe('Could not restore plugin-owned tab fields');

        service.tick();

        expect(host.names.has('uuid-a')).toBe(false);
        expect(host.headers.has('uuid-a')).toBe(false);
        expect(host.resetCount).toBe(2);
        expect(service.status().lastFailure).toBeUndefined();
    });
});
