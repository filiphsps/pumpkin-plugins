import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Absolute path of a plugin package's built `.wasm`, from its `pumpkinPlugin.output`.
 * Pass the package directory (usually `process.cwd()` under vitest).
 */
export function builtPluginPath(packageDir: string): string {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const output = pkg.pumpkinPlugin?.output;
    if (!output) throw new Error(`${packageDir}/package.json has no pumpkinPlugin.output`);
    const wasm = path.resolve(packageDir, output);
    if (!fs.existsSync(wasm)) throw new Error(`${wasm} is missing; run \`pnpm build\` first`);
    return wasm;
}
