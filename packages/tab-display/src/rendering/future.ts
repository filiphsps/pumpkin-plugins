import type { ApplyResult, RenderedLine } from '../model.ts';

/** A future per-viewer row rewrite request; no host API currently owns this surface safely. */
export interface PerViewerRowRequest {
    readonly displayName: RenderedLine;
    readonly subjectUuid: string;
    readonly viewerUuid: string;
}

/** A future synthetic layout section. Slot ownership and overflow policy are deliberately absent. */
export interface LayoutRequest {
    readonly rows: readonly RenderedLine[];
    readonly section: string;
    readonly viewerUuid: string;
}

/** Explicit disabled contracts for capabilities that need upstream typed packet ownership. */
export class FutureTabDisplayAdapter {
    /** No typed per-viewer row update API is exposed by the pinned WIT. */
    setPerViewerRow(_request: PerViewerRowRequest): ApplyResult {
        return {
            kind: 'unsupported',
            reason: 'Per-viewer player rows need an upstream typed writable packet event.',
        };
    }

    /** No safe synthetic player-list slot or profile ownership API is exposed by the pinned WIT. */
    setLayout(_request: LayoutRequest): ApplyResult {
        return {
            kind: 'unsupported',
            reason: 'Synthetic tab layouts need explicit profile, slot, and cleanup ownership.',
        };
    }
}
