import { applyEdits, modify } from 'jsonc-parser';
import type { TransformResult } from '../../types.js';
import { GENERATED_TYPES_GLOB } from './constants.js';
import { formattingOf, parseJsonObject } from './jsonc.js';

/** Adds the generated declaration glob to an explicit TypeScript include list. */
export function migrateTsconfig(source: string): TransformResult {
    const parsed = parseJsonObject(source);
    if (!parsed.value) return { source, messages: [parsed.error ?? 'Skipped an invalid tsconfig.json.'] };
    const include = parsed.value.include;
    if (include === undefined) return { source };
    if (!Array.isArray(include) || include.some((item) => typeof item !== 'string')) {
        return {
            source,
            messages: ['tsconfig.json has a non-string include value; add the generated type glob manually.'],
        };
    }
    if (include.includes(GENERATED_TYPES_GLOB)) return { source };
    const updated = applyEdits(
        source,
        modify(source, ['include'], [...include, GENERATED_TYPES_GLOB], { formattingOptions: formattingOf(source) }),
    );
    return { source: updated };
}
