/** A generated documentation block, including its markers, in a source Markdown string. */
export interface GeneratedBlock {
    name: string;
    markers: 'docs' | 'action';
    start: number;
    end: number;
    text: string;
}

/** Find complete generated blocks in either marker syntax, preserving source offsets and text. */
export function generatedBlocks(source: string): GeneratedBlock[] {
    const pattern =
        /<!--\s*(?:docs:begin\s+([\w-]+)\s*-->[\s\S]*?<!--\s*docs:end\s+\1|action-([\w-]+):start\s*-->[\s\S]*?<!--\s*action-\2:end)\s*-->/gi;
    return [...source.matchAll(pattern)].map((match) => ({
        name: match[1] ?? match[2],
        markers: match[1] ? 'docs' : 'action',
        start: match.index,
        end: match.index + match[0].length,
        text: match[0]
    }));
}

/** Remove complete generated blocks while preserving handwritten prose and unrelated comments. */
export function stripGeneratedBlocks(source: string): string {
    let result = '';
    let from = 0;
    for (const block of generatedBlocks(source)) {
        result += source.slice(from, block.start);
        from = block.end;
    }
    return result + source.slice(from);
}
