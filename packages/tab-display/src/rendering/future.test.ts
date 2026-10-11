import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ApplyResult, Capability } from '../model.ts';
import { FutureTabDisplayAdapter } from './future.ts';

describe('future display contracts', () => {
    it('keeps future packet ownership explicit and disabled', () => {
        const adapter = new FutureTabDisplayAdapter();
        expect(
            adapter.setPerViewerRow({
                viewerUuid: 'viewer',
                subjectUuid: 'subject',
                displayName: { text: 'Name' }
            })
        ).toMatchObject({ kind: 'unsupported', reason: expect.stringContaining('typed') });
        expect(adapter.setLayout({ viewerUuid: 'viewer', section: 'header', rows: [] })).toMatchObject({
            kind: 'unsupported',
            reason: expect.stringContaining('ownership')
        });
    });

    it('keeps capability and apply outcomes exhaustively discriminated', () => {
        expectTypeOf<Capability>().toEqualTypeOf<
            { readonly kind: 'supported' } | { readonly kind: 'unsupported'; readonly reason: string }
        >();
        expectTypeOf<ApplyResult>().toEqualTypeOf<
            | { readonly kind: 'applied' }
            | { readonly kind: 'unchanged' }
            | { readonly kind: 'unsupported'; readonly reason: string }
            | { readonly kind: 'failed'; readonly error: string }
        >();
    });
});
