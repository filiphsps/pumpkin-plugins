import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const filesystemState = vi.hoisted(() => ({ failSnapshotPublishTarget: undefined as string | undefined }));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        cpSync: vi.fn(actual.cpSync),
        renameSync: (...args: Parameters<typeof actual.renameSync>) => {
            if (
                filesystemState.failSnapshotPublishTarget === path.resolve(String(args[1])) &&
                path.basename(String(args[0])).startsWith('.wit-')
            ) {
                filesystemState.failSnapshotPublishTarget = undefined;
                throw new Error('injected snapshot publish failure');
            }
            return actual.renameSync(...args);
        },
    };
});

import { BuildError } from './errors.ts';
import { injectWasiImports, prepareWit, publishWitSnapshot } from './wit.ts';

const copy = vi.mocked(fs.cpSync).getMockImplementation();
if (!copy) throw new Error('node:fs.cpSync mock has no implementation');

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
    vi.mocked(fs.cpSync).mockReset().mockImplementation(copy);
    filesystemState.failSnapshotPublishTarget = undefined;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('injectWasiImports', () => {
    it('adds the imports just before the first export, keeping everything else', () => {
        const out = injectWasiImports(PLUGIN_WIT, ['io/poll', 'sockets/tcp']);
        expect(out).toContain(
            '    import wasi:io/poll@0.2.3;\n    import wasi:sockets/tcp@0.2.3;\n\n    export init-plugin',
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
        return { root, apiWit, wasiWit, wasiFiles: ['io/poll.wit'], target: path.join(root, 'out', 'wit') };
    }

    it('uses the API folder untouched when there is nothing to add', () => {
        const { apiWit, wasiFiles, target } = layout();
        expect(prepareWit({ apiWit, target, wasiFiles, interfaces: [] })).toBe(apiWit);
        expect(fs.existsSync(target)).toBe(false);
    });

    it('copies the API, adds the WASI packages under deps and imports them', () => {
        const { apiWit, wasiWit, wasiFiles, target } = layout();
        expect(prepareWit({ apiWit, target, wasiWit, wasiFiles, interfaces: ['io/poll'] })).toBe(target);
        expect(fs.readFileSync(path.join(target, 'other.wit'), 'utf8')).toBe('x');
        expect(fs.readFileSync(path.join(target, 'deps/io/poll.wit'), 'utf8')).toBe('package wasi:io;');
        expect(fs.readFileSync(path.join(target, 'plugin.wit'), 'utf8')).toContain('import wasi:io/poll@0.2.3;');
        expect(fs.readFileSync(path.join(apiWit, 'plugin.wit'), 'utf8')).toBe(PLUGIN_WIT);
    });

    it('preserves package metadata from the pinned WIT files', () => {
        const { apiWit, wasiWit, target } = layout();
        const packageWit = 'package wasi:http@0.2.3;\n// pinned package metadata\n';
        fs.mkdirSync(path.join(wasiWit, 'http'));
        fs.writeFileSync(path.join(wasiWit, 'http/package.wit'), packageWit);
        fs.writeFileSync(path.join(wasiWit, 'http/types.wit'), 'interface types {}');

        prepareWit({
            apiWit,
            target,
            wasiWit,
            wasiFiles: ['http/package.wit', 'http/types.wit'],
            interfaces: ['http/outgoing-handler'],
        });

        expect(fs.readFileSync(path.join(target, 'deps/http/package.wit'), 'utf8')).toBe(packageWit);
    });

    it('starts from a clean target every time', () => {
        const { apiWit, wasiWit, wasiFiles, target } = layout();
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'stale.wit'), 'old');
        prepareWit({ apiWit, target, wasiWit, wasiFiles, interfaces: ['io/poll'] });
        expect(fs.existsSync(path.join(target, 'stale.wit'))).toBe(false);
    });

    it('cleans a partial API copy before retrying a transient I/O error', () => {
        const { apiWit, wasiWit, wasiFiles, target } = layout();
        let attempts = 0;
        vi.mocked(fs.cpSync).mockImplementation((source, destination, options) => {
            if (source === apiWit && attempts++ === 0) {
                fs.writeFileSync(path.join(String(destination), 'stale.wit'), 'partial copy');
                throw Object.assign(new Error('temporary I/O error'), { code: 'EIO' });
            }
            return copy(source, destination, options);
        });

        prepareWit({ apiWit, wasiWit, wasiFiles, target, interfaces: ['io/poll'] });

        expect(fs.existsSync(path.join(target, 'stale.wit'))).toBe(false);
    });

    it('does not leave a temporary directory after preparation', () => {
        const { apiWit, wasiWit, wasiFiles, target } = layout();
        prepareWit({ apiWit, target, wasiWit, wasiFiles, interfaces: ['io/poll'] });

        expect(fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith('.wit-'))).toEqual([]);
    });

    it('needs the WASI files when it has interfaces to import', () => {
        const { apiWit, wasiFiles, target } = layout();
        expect(() => prepareWit({ apiWit, target, wasiFiles, interfaces: ['io/poll'] })).toThrow(BuildError);
    });
});

describe('publishWitSnapshot', () => {
    it('preserves the previous snapshot when publishing the staged snapshot fails', () => {
        const root = tmp();
        const source = path.join(root, 'source');
        const target = path.join(root, 'build', 'wit');
        fs.mkdirSync(source);
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(source, 'plugin.wit'), 'new snapshot');
        fs.writeFileSync(path.join(target, 'plugin.wit'), 'previous snapshot');
        filesystemState.failSnapshotPublishTarget = target;

        expect(() => publishWitSnapshot(source, target)).toThrow('injected snapshot publish failure');

        expect(fs.readFileSync(path.join(target, 'plugin.wit'), 'utf8')).toBe('previous snapshot');
        expect(fs.readdirSync(path.dirname(target))).toEqual(['wit']);
    });
});
