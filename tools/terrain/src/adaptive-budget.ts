/** Options for a work budget that adapts to recent host load and measured work cost. */
export interface AdaptiveWorkBudgetOptions {
    /** Work units to allow before a cost measurement is available. */
    initialUnits: number;
    /** Length of one server tick in milliseconds. Defaults to Minecraft's 50 ms tick. */
    tickDurationMs?: number;
    /** Time to leave for the server and other plugins. Defaults to 5 ms. */
    reserveMs?: number;
}

const COST_SMOOTHING = 0.25;

/** Scales bounded incremental work using server MSPT and measured cost per work unit. */
export class AdaptiveWorkBudget {
    private readonly initialUnits: number;
    private readonly tickDurationMs: number;
    private readonly reserveMs: number;
    private workMsPerUnit = 0;

    constructor(options: AdaptiveWorkBudgetOptions) {
        this.initialUnits = options.initialUnits;
        this.tickDurationMs = options.tickDurationMs ?? 50;
        this.reserveMs = options.reserveMs ?? 5;
        if (!Number.isSafeInteger(options.initialUnits) || options.initialUnits < 1) {
            throw new RangeError('Invalid initial work limit');
        }
        if (!Number.isFinite(this.tickDurationMs) || this.tickDurationMs <= 0) {
            throw new RangeError('Invalid tick duration');
        }
        if (!Number.isFinite(this.reserveMs) || this.reserveMs < 0 || this.reserveMs >= this.tickDurationMs) {
            throw new RangeError('Invalid reserved tick time');
        }
    }

    /** Returns the work units to attempt, capped by the caller's configured limit. */
    next(serverMspt: number, maxUnits: number): number {
        if (!Number.isSafeInteger(maxUnits) || maxUnits < 0) throw new RangeError('Invalid work limit');
        const initialUnits = Math.min(this.initialUnits, maxUnits);
        if (!Number.isFinite(serverMspt) || serverMspt < 0) return initialUnits;

        const availableMs = Math.max(0, this.tickDurationMs - serverMspt - this.reserveMs);
        if (availableMs === 0) return 0;

        const maxWorkMs = this.tickDurationMs - this.reserveMs;
        if (this.workMsPerUnit === 0) return Math.floor(initialUnits * (availableMs / maxWorkMs));

        return Math.min(maxUnits, Math.floor(availableMs / this.workMsPerUnit));
    }

    /** Updates the smoothed cost estimate after an incremental work step. */
    observe(units: number, elapsedMs: number): void {
        if (!Number.isSafeInteger(units) || units < 1 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return;

        const measuredMsPerUnit = elapsedMs / units;
        this.workMsPerUnit =
            this.workMsPerUnit === 0
                ? measuredMsPerUnit
                : this.workMsPerUnit * (1 - COST_SMOOTHING) + measuredMsPerUnit * COST_SMOOTHING;
    }
}
