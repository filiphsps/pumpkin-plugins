import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('loads under Node type stripping, as docs generators and plain Node consumers import it', () => {
    const entry = new URL('./index.ts', import.meta.url).href;
    const script = `const api = await import(${JSON.stringify(entry)}); console.log(typeof api.PieClient, typeof api.SESSION_TIMING);`;
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' });
    expect(output.trim()).toBe('function object');
});
