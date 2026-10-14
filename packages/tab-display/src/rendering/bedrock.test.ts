import { describe, expect, it } from 'vitest';
import { BedrockTabDisplayAdapter } from './bedrock.ts';

describe('native Bedrock display adapter', () => {
    it('reports unsupported features without changing player-list or scoreboard state', () => {
        const adapter = new BedrockTabDisplayAdapter();

        expect(adapter.objectiveCapability).toMatchObject({
            kind: 'unsupported',
            reason: expect.stringContaining('not verified'),
        });
        expect(adapter.setNumericObjective('bedrock-id', 12)).toEqual(adapter.objectiveCapability);
        expect(adapter.setEntryName('bedrock-id', { text: 'Never fabricated' })).toMatchObject({
            kind: 'unsupported',
            reason: expect.stringContaining('roster'),
        });
        expect(adapter.setOrder('bedrock-id', 0).kind).toBe('unsupported');
        expect(adapter.setHeaderFooter('bedrock-id', [], []).kind).toBe('unsupported');
        expect(() => adapter.resetOwned('bedrock-id')).not.toThrow();
    });
});
