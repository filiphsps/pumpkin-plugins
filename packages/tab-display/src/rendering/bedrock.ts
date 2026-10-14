import type { ApplyResult, Capability, RenderedLine } from '../model.ts';

const OBJECTIVE_UNSUPPORTED_REASON = 'The native Bedrock player-list objective is not verified on a Bedrock client.';

/** Native Bedrock surfaces that have not passed a real-client capability probe. */
export class BedrockTabDisplayAdapter {
    /** A numeric native player-list objective remains disabled until a Bedrock client displays it. */
    readonly objectiveCapability: Capability = {
        kind: 'unsupported',
        reason: OBJECTIVE_UNSUPPORTED_REASON,
    };

    /** Does not fabricate or rewrite roster entries. */
    setEntryName(_uuid: string, _value: RenderedLine | undefined): ApplyResult {
        return unsupported('row names');
    }

    /** Does not send Java list-order packets to Bedrock clients. */
    setOrder(_uuid: string, _order: number): ApplyResult {
        return unsupported('row ordering');
    }

    /** Does not send Java header/footer packets to Bedrock clients. */
    setHeaderFooter(_uuid: string, _header: readonly RenderedLine[], _footer: readonly RenderedLine[]): ApplyResult {
        return unsupported('header and footer');
    }

    /** Leaves Bedrock scoreboard and roster state untouched. */
    setNumericObjective(_uuid: string, _value: number): ApplyResult {
        return { kind: 'unsupported', reason: OBJECTIVE_UNSUPPORTED_REASON };
    }

    /** No Bedrock state is owned by the current adapter. */
    resetOwned(_uuid: string): void {}
}

function unsupported(feature: string): ApplyResult {
    return {
        kind: 'unsupported',
        reason: `Native Bedrock ${feature} are unsupported; the Pumpkin roster is left unchanged`,
    };
}
