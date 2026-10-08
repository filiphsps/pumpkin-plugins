import { describe, expect, it, vi } from 'vitest';
import type { Sessions } from '../session.ts';
import { invalidateBlockGrow, invalidateBlockSpread } from './world-mutations.ts';

describe('DH world mutation events', () => {
    it('invalidates the grown block position when the event is not cancelled', () => {
        const changedMany = vi.fn();
        const sessions = { changedMany } as unknown as Sessions;
        let disposed = false;
        const world = {
            getName: vi.fn(() => {
                if (disposed) throw new Error('World has been disposed');
                return 'world';
            }),
            [Symbol.dispose]: vi.fn(() => {
                disposed = true;
            })
        };

        invalidateBlockGrow(sessions, {
            targetWorld: world as never,
            oldBlock: 'minecraft:wheat',
            oldStateId: 1,
            newBlock: 'minecraft:wheat',
            newStateId: 2,
            blockPos: { x: 64, y: 70, z: -1 },
            cancelled: false
        });

        expect(changedMany).toHaveBeenCalledWith('world', [{ x: 64, z: -1 }]);
        expect(world.getName).toHaveBeenCalledOnce();
        expect(world.getName()).toBe('world');
    });

    it('invalidates the spread target instead of its source when uncancelled', () => {
        const changedMany = vi.fn();
        const sessions = { changedMany } as unknown as Sessions;
        let disposed = false;
        const world = {
            getName: vi.fn(() => {
                if (disposed) throw new Error('World has been disposed');
                return 'world';
            }),
            [Symbol.dispose]: vi.fn(() => {
                disposed = true;
            })
        };

        invalidateBlockSpread(sessions, {
            sourcePos: { x: 1, y: 70, z: 2 },
            targetPos: { x: 65, y: 71, z: -1 },
            targetWorld: world as never,
            newStateId: 3,
            cancelled: false
        });

        expect(changedMany).toHaveBeenCalledWith('world', [{ x: 65, z: -1 }]);
        expect(world.getName).toHaveBeenCalledOnce();
        expect(world.getName()).toBe('world');
    });

    it.each(['growth', 'spread'])('preserves the world of a cancelled %s event without invalidating it', (kind) => {
        const changedMany = vi.fn();
        const sessions = { changedMany } as unknown as Sessions;
        let disposed = false;
        const world = {
            getName: vi.fn(() => {
                if (disposed) throw new Error('World has been disposed');
                return 'world';
            }),
            [Symbol.dispose]: vi.fn(() => {
                disposed = true;
            })
        };
        const position = { x: 1, y: 70, z: 2 };

        if (kind === 'growth') {
            invalidateBlockGrow(sessions, {
                targetWorld: world as never,
                oldBlock: 'minecraft:wheat',
                oldStateId: 1,
                newBlock: 'minecraft:wheat',
                newStateId: 2,
                blockPos: position,
                cancelled: true
            });
        } else {
            invalidateBlockSpread(sessions, {
                sourcePos: position,
                targetPos: position,
                targetWorld: world as never,
                newStateId: 3,
                cancelled: true
            });
        }

        expect(changedMany).not.toHaveBeenCalled();
        expect(world.getName).not.toHaveBeenCalled();
        expect(world.getName()).toBe('world');
    });
});
