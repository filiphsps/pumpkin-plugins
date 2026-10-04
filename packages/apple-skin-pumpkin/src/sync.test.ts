import { describe, expect, it } from 'vitest';
import { EXHAUSTION_THRESHOLD, SyncTracker } from './sync.ts';

describe('SyncTracker', () => {
    it('sends both values the first time it sees a player, because the client starts on its own defaults', () => {
        const tracker = new SyncTracker();

        expect(tracker.update('ada', 5, 0.4)).toEqual({ saturation: 5, exhaustion: 0.4 });
    });

    it('sends nothing on a tick where neither value moved', () => {
        const tracker = new SyncTracker();
        tracker.update('ada', 5, 0.4);

        expect(tracker.update('ada', 5, 0.4)).toEqual({});
    });

    it('sends only the value that moved', () => {
        const tracker = new SyncTracker();
        tracker.update('ada', 5, 0.4);

        expect(tracker.update('ada', 4.5, 0.4)).toEqual({ saturation: 4.5 });
        expect(tracker.update('ada', 4.5, 1.2)).toEqual({ exhaustion: 1.2 });
    });

    it('holds back exhaustion that moved less than the threshold', () => {
        const tracker = new SyncTracker();
        tracker.update('ada', 5, 0.4);

        expect(tracker.update('ada', 5, 0.4 + EXHAUSTION_THRESHOLD / 2)).toEqual({});
    });

    it('adds up slow exhaustion drift until it is worth a packet', () => {
        const tracker = new SyncTracker();
        tracker.update('ada', 5, 0.4);
        const step = EXHAUSTION_THRESHOLD / 2;

        expect(tracker.update('ada', 5, 0.4 + step)).toEqual({});
        expect(tracker.update('ada', 5, 0.4 + step * 2)).toEqual({ exhaustion: 0.4 + step * 2 });
    });

    it('sends exhaustion once it has moved by the threshold itself', () => {
        const tracker = new SyncTracker();
        tracker.update('ada', 5, 0.4);

        expect(tracker.update('ada', 5, 0.4 - EXHAUSTION_THRESHOLD)).toEqual({
            exhaustion: 0.4 - EXHAUSTION_THRESHOLD
        });
    });

    it('tracks each player on their own', () => {
        const tracker = new SyncTracker();
        tracker.update('ada', 5, 0.4);

        expect(tracker.update('grace', 3, 2)).toEqual({ saturation: 3, exhaustion: 2 });
        expect(tracker.update('ada', 5, 0.4)).toEqual({});
    });

    it('sends everything again after a player is forgotten, so a rejoin is not stale', () => {
        const tracker = new SyncTracker();
        tracker.update('ada', 5, 0.4);
        tracker.forget('ada');

        expect(tracker.update('ada', 5, 0.4)).toEqual({ saturation: 5, exhaustion: 0.4 });
    });

    it('keeps the players who are still online when it drops the ones who are gone', () => {
        const tracker = new SyncTracker();
        tracker.update('ada', 5, 0.4);
        tracker.update('grace', 3, 2);
        expect(tracker.size).toBe(2);

        tracker.retain(new Set(['grace']));

        expect(tracker.size).toBe(1);
        expect(tracker.update('grace', 3, 2)).toEqual({});
    });
});
