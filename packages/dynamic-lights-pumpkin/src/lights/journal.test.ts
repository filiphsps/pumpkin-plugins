import { MemoryFiles } from '@pumpkin-plugins/plugin-kit/testing';
import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { BlockPosition } from './client-light.ts';
import { LightJournal, type LightRecoveryWorld } from './journal.ts';

describe(LightJournal.name, () => {
    it('restores light after an interrupted server', () => {
        const files = new MemoryFiles();
        const world = new FakeWorld();
        const position = block(4, 64, -8);
        writeJournal(files, position, 3, 14);
        world.setBlockLight(position, 14);

        const recovered = new LightJournal(files).recover([world]);

        expect(recovered).toBe(1);
        expect(world.getBlockLight(position)).toBe(3);
        expect(files.stat('active-lights.json')).toBeUndefined();
    });

    it('does not overwrite a light level changed after the interruption', () => {
        const files = new MemoryFiles();
        const world = new FakeWorld();
        const position = block(4, 64, -8);
        writeJournal(files, position, 3, 14);
        world.setBlockLight(position, 9);

        expect(new LightJournal(files).recover([world])).toBe(0);
        expect(world.getBlockLight(position)).toBe(9);
    });
});

class FakeWorld implements LightRecoveryWorld {
    readonly id = 'overworld';
    private readonly states = new Map<string, number>();

    getBlockLight(position: BlockPosition): number {
        return this.states.get(key(position)) ?? 0;
    }

    setBlockLight(position: BlockPosition, level: number): void {
        this.states.set(key(position), level);
    }
}

function writeJournal(files: MemoryFiles, position: BlockPosition, originalLevel: number, appliedLevel: number): void {
    files.writeFile(
        'active-lights.json',
        strToU8(
            JSON.stringify([
                {
                    key: `overworld:${position.x}:${position.y}:${position.z}`,
                    worldId: 'overworld',
                    position,
                    originalLevel,
                    appliedLevels: [appliedLevel]
                }
            ])
        )
    );
}

function block(x: number, y: number, z: number): BlockPosition {
    return { x, y, z };
}

function key(position: BlockPosition): string {
    return `${position.x}:${position.y}:${position.z}`;
}
