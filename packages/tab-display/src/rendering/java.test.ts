import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { TextComponent } from 'pumpkin:plugin/text@0.1.0';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JavaTabDisplayHost } from './java.ts';

const state = vi.hoisted(() => ({
    components: [] as Array<{
        value: string;
        style: Record<string, unknown>;
        children: unknown[];
        disposed: boolean;
    }>,
    fromJsonCalls: 0,
}));

vi.mock('pumpkin:plugin/text@0.1.0', () => {
    class MockTextComponent {
        value: string;
        style: Record<string, unknown> = {};
        children: MockTextComponent[] = [];
        disposed = false;
        private json: string | undefined;

        constructor(value: string) {
            this.value = value;
            state.components.push(this);
        }

        static text(value: string): MockTextComponent {
            return new MockTextComponent(value);
        }

        static fromJson(json: string): MockTextComponent {
            state.fromJsonCalls += 1;
            const component = new MockTextComponent('');
            component.json = json;
            return component;
        }

        addChild(child: MockTextComponent): void {
            this.children.push(child);
            child.transfer();
        }

        addText(value: string): void {
            this.value += value;
        }

        colorRgb(color: { r: number; g: number; b: number }): void {
            this.style.color = color;
        }

        bold(value: boolean): void {
            this.style.bold = value;
        }

        italic(value: boolean): void {
            this.style.italic = value;
        }

        underlined(value: boolean): void {
            this.style.underlined = value;
        }

        strikethrough(value: boolean): void {
            this.style.strikethrough = value;
        }

        toJson(): string {
            return this.json ?? JSON.stringify({ text: this.value, style: this.style, children: this.children });
        }

        get __isValid(): boolean {
            return !this.disposed;
        }

        transfer(): void {
            this.disposed = true;
        }

        [Symbol.dispose](): void {
            if (this.disposed) throw new Error('Cannot use a disposed or transferred resource');
            this.disposed = true;
        }
    }

    return { TextComponent: MockTextComponent };
});

vi.mock('pumpkin:plugin/uuid@0.1.0', () => ({ toString: (id: { value: string }) => id.value }));

function javaPlayer(id: string, version = 'v-26-3') {
    let currentName: string | undefined;
    const nameWrites: Array<string | undefined> = [];
    let playerDisposals = 0;
    let javaDisposals = 0;
    let javaHandleDisposals = 0;
    let bedrockHandleDisposals = 0;
    const player = {
        getId: () => ({ value: id }),
        getName: () => `Player-${id}`,
        asJava: () => ({
            getVersion: () => version,
            [Symbol.dispose]: () => {
                javaDisposals += 1;
                javaHandleDisposals += 1;
            },
        }),
        asBedrock: () => ({ [Symbol.dispose]: () => (bedrockHandleDisposals += 1) }),
        getTabListName: () => (currentName === undefined ? undefined : TextComponent.fromJson(currentName)),
        setTabListName: (component: ReturnType<typeof TextComponent.text> | undefined) => {
            currentName = component?.toJson();
            transferTextComponent(component);
            nameWrites.push(currentName);
        },
        setTabListHeaderFooter: vi.fn((header: TextComponent, footer: TextComponent) => {
            transferTextComponent(header);
            transferTextComponent(footer);
        }),
        [Symbol.dispose]: () => {
            playerDisposals += 1;
        },
    };
    return {
        player: player as unknown as Player,
        nameWrites,
        currentName: () => currentName,
        setCurrentName: (value: string | undefined) => {
            currentName = value;
        },
        javaDisposals: () => javaDisposals,
        javaHandleDisposals: () => javaHandleDisposals,
        bedrockHandleDisposals: () => bedrockHandleDisposals,
        playerDisposals: () => playerDisposals,
    };
}

function bedrockPlayer(id: string) {
    let playerDisposals = 0;
    let bedrockDisposals = 0;
    const player = {
        getId: () => ({ value: id }),
        getName: () => `Player-${id}`,
        asJava: () => undefined,
        asBedrock: () => ({ [Symbol.dispose]: () => (bedrockDisposals += 1) }),
        setTabListName: vi.fn(),
        setTabListHeaderFooter: vi.fn(),
        [Symbol.dispose]: () => {
            playerDisposals += 1;
        },
    };
    return {
        player: player as unknown as Player,
        playerDisposals: () => playerDisposals,
        bedrockDisposals: () => bedrockDisposals,
        setTabListName: player.setTabListName,
        setTabListHeaderFooter: player.setTabListHeaderFooter,
    };
}

function transferTextComponent(component: unknown): void {
    if (component === undefined) return;
    (component as { transfer: () => void }).transfer();
}

function fakeServer(players: readonly Player[]): Server {
    return { getAllPlayers: () => [...players] } as unknown as Server;
}

describe('Java tab display host', () => {
    beforeEach(() => {
        state.components = [];
        state.fromJsonCalls = 0;
    });

    it('copies primitive snapshots and disposes edition and player handles at their boundaries', () => {
        const java = javaPlayer('java');
        const bedrock = bedrockPlayer('bedrock');
        const host = new JavaTabDisplayHost();
        host.setServer(fakeServer([java.player, bedrock.player]));

        expect(host.snapshotPlayers(10)).toEqual([
            { uuid: 'java', name: 'Player-java', edition: 'java', javaVersion: 'v-26-3' },
            { uuid: 'bedrock', name: 'Player-bedrock', edition: 'bedrock' },
        ]);
        expect(java.javaHandleDisposals()).toBe(1);
        expect(java.playerDisposals()).toBe(0);
        expect(bedrock.bedrockDisposals()).toBe(1);

        host.endTick();
        expect(java.playerDisposals()).toBe(1);
        expect(bedrock.playerDisposals()).toBe(1);
    });

    it('applies literal styled header and footer text only to Java clients', () => {
        const java = javaPlayer('java');
        const bedrock = bedrockPlayer('bedrock');
        const host = new JavaTabDisplayHost();
        host.setServer(fakeServer([java.player, bedrock.player]));
        host.snapshotPlayers(10);

        expect(
            host.setHeaderFooter(
                'java',
                [
                    { text: 'Hello %player_name%', color: '#123456', bold: true },
                    { text: 'Second', italic: true },
                ],
                [{ text: 'Footer' }],
            ),
        ).toEqual({ kind: 'applied' });
        expect(host.setHeaderFooter('bedrock', [], [])).toMatchObject({
            kind: 'unsupported',
            reason: expect.stringContaining('Bedrock'),
        });
        expect(
            (java.player as unknown as { setTabListHeaderFooter: ReturnType<typeof vi.fn> }).setTabListHeaderFooter,
        ).toHaveBeenCalledTimes(1);
        expect(bedrock.setTabListHeaderFooter).not.toHaveBeenCalled();

        const roots = state.components.filter((component) => component.children.length > 0);
        expect(roots).toHaveLength(2);
        expect(roots[0]?.children).toHaveLength(3);
        expect(roots[0]?.children[0]).toMatchObject({
            value: 'Hello %player_name%',
            style: { color: { r: 18, g: 52, b: 86 }, bold: true },
        });
        expect(roots[0]?.children[1]).toMatchObject({ value: '\n' });
        expect(roots[0]?.value).toBe('');
        expect(state.fromJsonCalls).toBe(0);
        host.endTick();
    });

    it('does not dispose text components after the Pumpkin API takes ownership', () => {
        const player = javaPlayer('java');
        const host = new JavaTabDisplayHost();
        host.setServer(fakeServer([player.player]));
        host.snapshotPlayers(10);

        expect(host.setHeaderFooter('java', [{ text: 'Header' }], [{ text: 'Footer' }])).toEqual({ kind: 'applied' });

        host.endTick();
    });

    it('restores owned text resources on shutdown without disposing transferred handles', () => {
        const player = javaPlayer('java');
        const host = new JavaTabDisplayHost();
        host.setServer(fakeServer([player.player]));
        host.snapshotPlayers(10);
        host.setEntryName('java', { text: 'Owned name' });
        host.setHeaderFooter('java', [{ text: 'Owned header' }], [{ text: 'Owned footer' }]);

        expect(() => host.resetOwned('java')).not.toThrow();
        expect(player.currentName()).toBeUndefined();

        host.endTick();
    });

    it('restores a captured tab name only while the current name is still owned', () => {
        const player = javaPlayer('java');
        const originalJson = '{"text":"Original","color":"gold"}';
        player.setCurrentName(originalJson);
        const host = new JavaTabDisplayHost();
        host.setServer(fakeServer([player.player]));
        host.snapshotPlayers(10);

        expect(host.setEntryName('java', { text: 'New §c Name', color: '#ABCDEF' })).toEqual({ kind: 'applied' });
        expect(player.currentName()).not.toBe(originalJson);
        expect(state.fromJsonCalls).toBe(1);
        expect(host.setEntryName('java', undefined)).toEqual({ kind: 'applied' });
        expect(player.currentName()).toBe(originalJson);
        expect(player.nameWrites).toHaveLength(2);
        host.endTick();
    });

    it('preserves an originally empty row name across repeated plugin updates', () => {
        const player = javaPlayer('java');
        const host = new JavaTabDisplayHost();
        host.setServer(fakeServer([player.player]));
        host.snapshotPlayers(10);

        expect(host.setEntryName('java', { text: 'First' }).kind).toBe('applied');
        expect(host.setEntryName('java', { text: 'Second' }).kind).toBe('applied');
        host.resetOwned('java');

        expect(player.currentName()).toBeUndefined();
        expect(player.nameWrites).toHaveLength(3);
        host.endTick();
    });

    it('leaves a tab name changed by another plugin untouched during reset', () => {
        const player = javaPlayer('java');
        const host = new JavaTabDisplayHost();
        host.setServer(fakeServer([player.player]));
        host.snapshotPlayers(10);
        host.setEntryName('java', { text: 'Owned' });
        player.setCurrentName('{"text":"External"}');

        host.resetOwned('java');
        expect(player.currentName()).toBe('{"text":"External"}');
        expect(player.nameWrites).toHaveLength(1);
        host.endTick();
    });

    it('formats Java players on any protocol version the server accepts', () => {
        const player = javaPlayer('java', 'v-26-4');
        const host = new JavaTabDisplayHost();
        host.setServer(fakeServer([player.player]));
        host.snapshotPlayers(10);

        expect(host.setEntryName('java', { text: 'Name' })).toEqual({ kind: 'applied' });
        expect(host.setHeaderFooter('java', [{ text: 'Header' }], [])).toEqual({ kind: 'applied' });
        host.endTick();
    });

    it('never writes Java player-list fields to Bedrock handles', () => {
        const player = bedrockPlayer('bedrock');
        const host = new JavaTabDisplayHost();
        host.setServer(fakeServer([player.player]));
        host.snapshotPlayers(10);

        expect(host.setEntryName('bedrock', { text: 'Name' })).toMatchObject({ kind: 'unsupported' });
        expect(host.setHeaderFooter('bedrock', [], [])).toMatchObject({ kind: 'unsupported' });
        expect(player.setTabListName).not.toHaveBeenCalled();
        expect(player.setTabListHeaderFooter).not.toHaveBeenCalled();
        host.endTick();
    });
});
