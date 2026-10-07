import { describe, expect, it } from 'vitest';
import { AdaptiveWorkBudget } from './adaptive-budget.ts';

describe('adaptive terrain work budget', () => {
    it('starts conservatively, expands when sample work is cheap, and respects MSPT headroom', () => {
        const budget = new AdaptiveWorkBudget({ initialUnits: 8192 });

        expect(budget.next(0, 32768)).toBe(8192);
        expect(budget.next(44, 32768)).toBeLessThan(8192);
        expect(budget.next(45, 32768)).toBe(0);

        budget.observe(8192, 5);
        expect(budget.next(0, 32768)).toBe(32768);
    });

    it('ignores invalid measurements and limits the budget to the current caller cap', () => {
        const budget = new AdaptiveWorkBudget({ initialUnits: 8192 });

        budget.observe(0, 1);
        budget.observe(8192, 0);
        expect(budget.next(0, 64)).toBe(64);
        expect(budget.next(Number.NaN, 32768)).toBe(8192);
    });

    it('rejects invalid limits', () => {
        expect(() => new AdaptiveWorkBudget({ initialUnits: 0 })).toThrow('initial work limit');
        expect(() => new AdaptiveWorkBudget({ initialUnits: 1, reserveMs: 50 })).toThrow('reserved tick time');
        expect(() => new AdaptiveWorkBudget({ initialUnits: 1, tickDurationMs: 0 })).toThrow('tick duration');
    });
});
