import type { ResolvedLine } from '@pumpkin-plugins/pumpkin-pie-api';
import { strFromU8, strToU8 } from 'fflate';

/** Maximum configured template input size, measured as UTF-8 bytes. */
export const MAX_TEMPLATE_BYTES = 4 * 1024;
/** Maximum rendered field size, measured as UTF-8 bytes. Longer fields are cut to fit. */
export const MAX_RENDERED_FIELD_BYTES = 8 * 1024;

/** A parsed token or literal segment from one configured field. */
export type TemplatePart =
    | { readonly kind: 'literal'; readonly text: string }
    | { readonly kind: 'placeholder'; readonly id: string; readonly token: string };

/** A bounded, host-independent compiled template. */
export interface CompiledTemplate {
    readonly hasPlaceholders: boolean;
    readonly parts: readonly TemplatePart[];
    readonly placeholderIds: readonly string[];
    readonly source: string;
}

/** How an unresolved token is shown. */
export type PlaceholderFallback = 'literal' | 'empty';

/** Splits `%identifier%` tokens from plain text without interpreting provider output. */
export function compileTemplate(source: string): CompiledTemplate {
    if (typeof source !== 'string' || strToU8(source).length > MAX_TEMPLATE_BYTES) {
        throw new RangeError('Template input must be at most 4 KiB in UTF-8');
    }

    const parts: TemplatePart[] = [];
    const identifiers = new Set<string>();
    const tokenPattern = /%([a-zA-Z0-9_]+)%/g;
    let offset = 0;
    for (let match = tokenPattern.exec(source); match !== null; match = tokenPattern.exec(source)) {
        if (match.index > offset) parts.push({ kind: 'literal', text: source.slice(offset, match.index) });
        const id = match[1];
        if (id === undefined) continue;
        const token = match[0];
        parts.push({ kind: 'placeholder', id, token });
        identifiers.add(id);
        offset = match.index + token.length;
    }
    if (offset < source.length) parts.push({ kind: 'literal', text: source.slice(offset) });

    return {
        source,
        parts,
        placeholderIds: [...identifiers],
        hasPlaceholders: identifiers.size > 0,
    };
}

/**
 * Renders one provider result as literal text, applying fallback only to unresolved tokens.
 *
 * @param builtins - Values used for matching tokens when there is no provider result, so common
 * tokens such as `%player_name%` still render without PumpkinPIE.
 */
export function renderTemplate(
    template: CompiledTemplate,
    resolution: ResolvedLine | undefined,
    fallback: PlaceholderFallback,
    providerAvailable: boolean,
    builtins: ReadonlyMap<string, string> = new Map(),
): string {
    if (!template.hasPlaceholders) return template.source;
    if (!providerAvailable || resolution === undefined) {
        return bounded(
            template.parts
                .map((part) =>
                    part.kind === 'literal'
                        ? part.text
                        : (builtins.get(part.id) ?? (fallback === 'literal' ? part.token : '')),
                )
                .join(''),
        );
    }

    const unresolved = new Set(resolution.unresolved);
    let rendered = resolution.text;
    if (fallback === 'empty' && unresolved.size > 0) {
        for (const part of template.parts) {
            if (part.kind === 'placeholder' && unresolved.has(part.id)) rendered = rendered.split(part.token).join('');
        }
    }
    return bounded(rendered);
}

function bounded(text: string): string {
    const bytes = strToU8(text);
    if (bytes.length <= MAX_RENDERED_FIELD_BYTES) return text;
    // Step back over UTF-8 continuation bytes so the cut never splits a character.
    let end = MAX_RENDERED_FIELD_BYTES;
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    return strFromU8(bytes.subarray(0, end));
}
