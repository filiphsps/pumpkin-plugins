import { expect, it } from 'vitest';
import { readParseTypeScript } from './build-log.ts';

// What pumpkin-plugins-build prints for a --parse-ts build with PUMPKIN_PLUGINS_BUILD_LOG_FORMAT=json.
const typeScriptParserBuild = [
    '{"type":"bundle","entry":"src/plugin.ts","engine":"static-hermes","runtimeVariant":"lean","gcVariant":"hades","parseTypeScript":true}',
    '{"type":"componentize","engine":"static-hermes","runtimeVariant":"lean","gcVariant":"hades","parseTypeScript":true}',
    '{"type":"built","output":"build/plugin.wasm","sizeBytes":2048}',
].join('\n');

it('reads the parser mode that the componentize message reports', () => {
    expect(readParseTypeScript(typeScriptParserBuild)).toBe(true);
    expect(
        readParseTypeScript(
            '{"type":"componentize","engine":"static-hermes","runtimeVariant":"lean","gcVariant":"hades"}\n',
        ),
    ).toBe(false);
    expect(readParseTypeScript('{"type":"componentize","engine":"quickjs"}')).toBe(false);
});

it('skips toolchain output printed between build messages', () => {
    expect(readParseTypeScript(`Hermes build cache is current; skipping rebuild.\r\n${typeScriptParserBuild}`)).toBe(
        true,
    );
});

it('rejects a build log without exactly one componentize message', () => {
    expect(() => readParseTypeScript('[build] Componentizing with Static Hermes (lean, hades, TS parser)...')).toThrow(
        'found 0',
    );
    expect(() => readParseTypeScript(`${typeScriptParserBuild}\n${typeScriptParserBuild}`)).toThrow('found 2');
});
