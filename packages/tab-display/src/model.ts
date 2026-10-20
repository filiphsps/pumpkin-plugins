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
    readonly edition: 'java' | 'bedrock' | 'unknown';
    readonly javaVersion?: string;
    readonly name: string;
    readonly uuid: string;
}

/** Plain text plus style options; resolved placeholder output is always text. */
export interface RenderedLine {
    readonly bold?: boolean;
    readonly color?: string;
    readonly italic?: boolean;
    readonly strikethrough?: boolean;
    readonly text: string;
    readonly underlined?: boolean;
}

/** Read-only status exposed to commands and diagnostics. */
export interface TabDisplayStatus {
    readonly bedrock: Capability;
    readonly bedrockPlayers: number;
    readonly enabled: boolean;
    readonly javaPlayers: number;
    readonly javaVersions: readonly string[];
    readonly lastFailure?: string;
    readonly pendingJobs: number;
    readonly players: number;
    readonly provider: SessionState['kind'];
    readonly unresolved: readonly string[];
}
