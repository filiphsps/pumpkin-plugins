import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BuildError } from './errors.ts';
import { injectWasiImports, prepareWit } from './wit.ts';

const PLUGIN_WIT = `world plugin {
    import logging;

    export init-plugin: func();
    export on-load: func();
}
`;

const dirs: string[] = [];
const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wit-'));
    dirs.push(dir);
    return dir;
};
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('injectWasiImports', () => {
    it('adds the imports just before the first export, keeping everything else', () => {
        const out = injectWasiImports(PLUGIN_WIT, ['io/poll', 'sockets/tcp']);
        expect(out).toContain(
            '    import wasi:io/poll@0.2.3;\n    import wasi:sockets/tcp@0.2.3;\n\n    export init-plugin'
        );
        expect(out.indexOf('import wasi:io/poll')).toBeLessThan(out.indexOf('export init-plugin'));
        expect(out.startsWith('world plugin {\n    import logging;')).toBe(true);
        expect(out.endsWith('export on-load: func();\n}\n')).toBe(true);
    });

    it('fails loudly when the API layout no longer has exports to anchor on', () => {
        expect(() => injectWasiImports('world plugin { import logging; }', ['io/poll'])).toThrow(BuildError);
    });
});

describe('prepareWit', () => {
    function layout() {
        const root = tmp();
        const apiWit = path.join(root, 'api');
        const wasiWit = path.join(root, 'wasi');
        fs.mkdirSync(apiWit);
        fs.mkdirSync(path.join(wasiWit, 'io'), { recursive: true });
        fs.writeFileSync(path.join(apiWit, 'plugin.wit'), PLUGIN_WIT);
        fs.writeFileSync(path.join(apiWit, 'other.wit'), 'x');
        fs.writeFileSync(path.join(wasiWit, 'io/poll.wit'), 'package wasi:io;');
        return { root, apiWit, wasiWit, target: path.join(root, 'out', 'wit') };
    }

    it('uses the API folder untouched when there is nothing to add', () => {
        const { apiWit, target } = layout();
        expect(prepareWit({ apiWit, target, interfaces: [] })).toBe(apiWit);
        expect(fs.existsSync(target)).toBe(false);
    });

    it('copies the API, adds the WASI packages under deps and imports them', () => {
        const { apiWit, wasiWit, target } = layout();
        expect(prepareWit({ apiWit, target, wasiWit, interfaces: ['io/poll'] })).toBe(target);
        expect(fs.readFileSync(path.join(target, 'other.wit'), 'utf8')).toBe('x');
        expect(fs.readFileSync(path.join(target, 'deps/io/poll.wit'), 'utf8')).toBe('package wasi:io;');
        expect(fs.readFileSync(path.join(target, 'plugin.wit'), 'utf8')).toContain('import wasi:io/poll@0.2.3;');
        expect(fs.readFileSync(path.join(apiWit, 'plugin.wit'), 'utf8')).toBe(PLUGIN_WIT);
    });

    it('starts from a clean target every time', () => {
        const { apiWit, wasiWit, target } = layout();
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'stale.wit'), 'old');
        prepareWit({ apiWit, target, wasiWit, interfaces: ['io/poll'] });
        expect(fs.existsSync(path.join(target, 'stale.wit'))).toBe(false);
    });

    it('needs the WASI files when it has interfaces to import', () => {
        const { apiWit, target } = layout();
        expect(() => prepareWit({ apiWit, target, interfaces: ['io/poll'] })).toThrow(BuildError);
    });
});
