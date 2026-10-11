import type { SessionState } from '@pumpkin-plugins/pumpkin-pie-api';

/** Host capability result for an edition-specific feature. */
export type Capability = { readonly kind: 'supported' } | { readonly kind: 'unsupported'; readonly reason: string };

/** Outcome of one attempted host update. */
export type ApplyResult =
    | { readonly kind: 'applied' }
    | { readonly kind: 'unchanged' }
    | { readonly kind: 'unsupported'; readonly reason: string }
    | { readonly kind: 'failed'; readonly error: string };

/** A configured literal node or one PIE placeholder. */
export type TextPart =
    | { readonly kind: 'literal'; readonly text: string }
    | { readonly kind: 'placeholder'; readonly id: string; readonly argument?: string };

/** Edition-specific source player data copied from short-lived WIT resources. */
export interface PlayerSnapshot {
    readonly uuid: string;
    readonly name: string;
    readonly edition: 'java' | 'bedrock' | 'unknown';
    readonly ping?: number;
}

/** Plain text plus style options; resolved placeholder output is always text. */
export interface RenderedLine {
    readonly text: string;
    readonly color?: string;
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly underlined?: boolean;
    readonly strikethrough?: boolean;
}

/** Read-only status exposed to commands and diagnostics. */
export interface TabDisplayStatus {
    readonly enabled: boolean;
    readonly provider: SessionState['kind'];
    readonly players: number;
    readonly javaPlayers: number;
    readonly bedrockPlayers: number;
    readonly pendingJobs: number;
    readonly unresolved: readonly string[];
    readonly lastFailure?: string;
    readonly java: Capability;
    readonly bedrock: Capability;
}
