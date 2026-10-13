/**
 * Parse paths from `git status --porcelain=v1 -z` output.
 *
 * Rename and copy records contain both the destination and source paths; both are returned so
 * callers can enforce allowlists against every affected file.
 *
 * @param status - NUL-delimited Git porcelain status output.
 * @returns Changed paths in status order, including both sides of rename and copy records.
 * @throws {Error} If Git returns a malformed or incomplete status record.
 */
export function parseHermesGitStatusPaths(status: string): string[] {
    const records = status.split('\0');
    const paths: string[] = [];
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (!record) continue;
        if (record.length < 4 || record[2] !== ' ') {
            throw new Error('Git returned malformed Hermes source status output');
        }

        const state = record.slice(0, 2);
        paths.push(record.slice(3));
        if (state.includes('R') || state.includes('C')) {
            const source = records[index + 1];
            if (!source) throw new Error('Git returned an incomplete Hermes source rename or copy record');
            paths.push(source);
            index += 1;
        }
    }
    return paths;
}
