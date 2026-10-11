import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { makeMcpack, manifestJson, noise } from '../../test/fixtures.ts';
import { MemoryFiles } from '../../test/memory-files.ts';
import { readManifest } from './manifest.ts';
import { PackScanner } from './scanner.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pack = (n: number) => makeMcpack(manifestJson({ uuid: uuid(n) }));

describe('PackScanner', () => {
    it('finds .mcpack files in name order and ignores everything else', () => {
        const files = new MemoryFiles()
            .put('packs/b.mcpack', pack(2))
            .put('packs/A.MCPACK', pack(1))
            .put('packs/notes.txt', 'hi')
            .put('packs/sub/c.mcpack', pack(3));
        const { packs, problems } = new PackScanner(files).scan('packs');
        expect(packs.map((p) => [p.fileName, p.manifest.uuid])).toEqual([
            ['A.MCPACK', uuid(1)],
            ['b.mcpack', uuid(2)]
        ]);
        expect(problems).toEqual([]);
    });

    it('reports packs it cannot read and carries on with the rest', () => {
        const files = new MemoryFiles()
            .put('packs/good.mcpack', pack(1))
            .put('packs/broken.mcpack', 'not a zip')
            .put('packs/nomanifest.mcpack', makeMcpack('{"modules": []}'));
        const { packs, problems } = new PackScanner(files).scan('packs');
        expect(packs.map((p) => p.fileName)).toEqual(['good.mcpack']);
        expect(problems).toEqual([
            'broken.mcpack: not a valid zip archive',
            'nomanifest.mcpack: manifest.json has no header'
        ]);
    });

    it('only rereads packs whose size or modification time changed', () => {
        const files = new MemoryFiles().put('packs/a.mcpack', pack(1)).put('packs/b.mcpack', pack(2));
        const scanner = new PackScanner(files);
        scanner.scan('packs');
        scanner.scan('packs');
        expect([files.reads.get('packs/a.mcpack'), files.reads.get('packs/b.mcpack')]).toEqual([1, 1]);

        files.put('packs/a.mcpack', makeMcpack(manifestJson({ uuid: uuid(9), version: [2, 0, 0] })));
        const { packs } = scanner.scan('packs');
        expect(files.reads.get('packs/a.mcpack')).toBe(2);
        expect(files.reads.get('packs/b.mcpack')).toBe(1);
        expect(packs.find((p) => p.fileName === 'a.mcpack')?.manifest).toMatchObject({
            uuid: uuid(9),
            version: '2.0.0'
        });
    });

    it('remembers a broken pack too, instead of reparsing it every scan', () => {
        const files = new MemoryFiles().put('packs/broken.mcpack', 'not a zip');
        const scanner = new PackScanner(files);
        scanner.scan('packs');
        expect(scanner.scan('packs').problems).toEqual(['broken.mcpack: not a valid zip archive']);
        expect(files.reads.get('packs/broken.mcpack')).toBe(1);
    });

    it('notices removed packs and forgets them', () => {
        const files = new MemoryFiles().put('packs/a.mcpack', pack(1));
        const scanner = new PackScanner(files);
        expect(scanner.scan('packs').packs).toHaveLength(1);
        files.remove('packs/a.mcpack');
        expect(scanner.scan('packs').packs).toHaveLength(0);
        files.put('packs/a.mcpack', pack(1));
        scanner.scan('packs');
        expect(files.reads.get('packs/a.mcpack')).toBe(2);
    });

    it('reads the size from the folder, so big packs are listed with their real size', () => {
        const big = makeMcpack(manifestJson(), { files: { 'a.bin': noise(100_000) } });
        const files = new MemoryFiles().put('packs/big.mcpack', big);
        expect(new PackScanner(files).scan('packs').packs[0].size).toBe(big.length);
    });

    describe('.mcaddon bundles', () => {
        const manifest = (n: number, modules: string[] = ['resources']) =>
            strToU8(JSON.stringify(manifestJson({ uuid: uuid(n), modules })));
        const addon = (entries: Record<string, Uint8Array>) => zipSync(entries);

        it('lists the resource pack of a bundle under the bundle name and writes it out to be served', () => {
            const files = new MemoryFiles().put(
                'packs/Double Hands.mcaddon',
                addon({
                    'RP/manifest.json': manifest(1),
                    'RP/textures/a.png': noise(300),
                    'BP/manifest.json': manifest(2, ['data'])
                })
            );
            const { packs, problems } = new PackScanner(files).scan('packs');

            expect(packs.map((p) => [p.fileName, p.manifest.uuid])).toEqual([['Double Hands.mcpack', uuid(1)]]);
            expect(packs[0].path).toBe('packs/.extracted/Double Hands.mcaddon/Double Hands.mcpack');
            expect(files.stat(packs[0].path)?.size).toBe(packs[0].size);
            expect(problems).toEqual(['Double Hands.mcaddon: left out BP (data, not a resource pack)']);
        });

        it('names the packs of a bundle with several after the bundle and the pack', () => {
            const files = new MemoryFiles().put(
                'packs/Pair.mcaddon',
                addon({ 'Hi/manifest.json': manifest(1), 'Lo/manifest.json': manifest(2) })
            );
            const { packs } = new PackScanner(files).scan('packs');
            expect(packs.map((p) => p.fileName).sort()).toEqual(['Pair - Hi.mcpack', 'Pair - Lo.mcpack']);
        });

        it('reserves equal leaf names before extracting conflicting bytes', () => {
            const files = new MemoryFiles().put(
                'packs/Pair.mcaddon',
                addon({
                    'a/RP/manifest.json': manifest(1),
                    'b/RP/manifest.json': manifest(2)
                })
            );
            const scanner = new PackScanner(files);
            for (let scan = 0; scan < 2; scan++) {
                const { packs, problems } = scanner.scan('packs');
                expect(packs.map((p) => p.manifest.uuid)).toEqual([uuid(1)]);
                expect(readManifest(files.readFile(packs[0].path)).uuid).toBe(uuid(1));
                expect(problems).toEqual([
                    'Pair.mcaddon: Pair - RP.mcpack is already taken by Pair.mcaddon; skipping it'
                ]);
            }
        });

        it('reserves direct and earlier bundle names before writing colliding candidates', () => {
            const files = new MemoryFiles()
                .put('packs/A - RP.mcpack', pack(1))
                .put('packs/A.mcaddon', addon({ 'RP/manifest.json': manifest(2), 'Other/manifest.json': manifest(3) }))
                .put('packs/A - RP.mcaddon', addon({ 'RP/manifest.json': manifest(4) }));
            const scanner = new PackScanner(files);
            for (let scan = 0; scan < 2; scan++) {
                const { packs } = scanner.scan('packs');
                expect(packs.map((p) => p.manifest.uuid)).toEqual([uuid(1), uuid(3)]);
                for (const p of packs) expect(readManifest(files.readFile(p.path)).uuid).toBe(p.manifest.uuid);
                expect(files.stat('packs/.extracted/A.mcaddon/A - RP.mcpack')).toBeUndefined();
                expect(files.stat('packs/.extracted/A - RP.mcaddon/A - RP.mcpack')).toBeUndefined();
            }
            files.remove('packs/A - RP.mcpack');
            const { packs } = scanner.scan('packs');
            expect(packs.map((p) => p.manifest.uuid)).toEqual([uuid(4), uuid(3)]);
            for (const p of packs) expect(readManifest(files.readFile(p.path)).uuid).toBe(p.manifest.uuid);
            expect(files.stat('packs/.extracted/A.mcaddon/A - RP.mcpack')).toBeUndefined();
        });

        it('says when a bundle has no resource pack and when it is not a zip', () => {
            const files = new MemoryFiles()
                .put('packs/OnlyBp.mcaddon', addon({ 'BP/manifest.json': manifest(1, ['data']) }))
                .put('packs/Broken.mcaddon', 'nope');
            const { packs, problems } = new PackScanner(files).scan('packs');
            expect(packs).toEqual([]);
            expect(problems).toEqual([
                'Broken.mcaddon: not a valid zip archive',
                'OnlyBp.mcaddon: left out BP (data, not a resource pack)',
                'OnlyBp.mcaddon: has no resource pack'
            ]);
        });

        it('extracts a bundle once, and again when it changes', () => {
            const files = new MemoryFiles().put('packs/A.mcaddon', addon({ 'RP/manifest.json': manifest(1) }));
            const scanner = new PackScanner(files);
            const first = scanner.scan('packs').packs[0];
            const written = files.stat(first.path)?.modified;
            scanner.scan('packs');
            expect(files.stat(first.path)?.modified).toBe(written);

            files.put('packs/A.mcaddon', addon({ 'RP/manifest.json': manifest(3) }));
            expect(scanner.scan('packs').packs[0].manifest.uuid).toBe(uuid(3));
        });

        it('removes what it extracted when the bundle goes away or no longer has the pack', () => {
            const files = new MemoryFiles()
                .put('packs/A.mcaddon', addon({ 'Hi/manifest.json': manifest(1), 'Lo/manifest.json': manifest(2) }))
                .put('packs/B.mcaddon', addon({ 'RP/manifest.json': manifest(5) }));
            const scanner = new PackScanner(files);
            scanner.scan('packs');
            expect(files.list('packs/.extracted/A.mcaddon')).toHaveLength(2);

            files.put('packs/A.mcaddon', addon({ 'Hi/manifest.json': manifest(1) }));
            scanner.scan('packs');
            expect(files.list('packs/.extracted/A.mcaddon')).toEqual(['A.mcpack']);

            files.remove('packs/A.mcaddon');
            scanner.scan('packs');
            expect(files.stat('packs/.extracted/A.mcaddon')).toBeUndefined();
            expect(files.list('packs/.extracted/B.mcaddon')).toEqual(['B.mcpack']);
        });

        it('skips a pack whose name is already taken by another file', () => {
            const files = new MemoryFiles()
                .put('packs/Same.mcpack', pack(1))
                .put('packs/Same.mcaddon', addon({ 'RP/manifest.json': manifest(2) }));
            const { packs, problems } = new PackScanner(files).scan('packs');
            expect(packs.map((p) => p.manifest.uuid)).toEqual([uuid(1)]);
            expect(problems).toEqual(['Same.mcaddon: Same.mcpack is already taken by Same.mcpack; skipping it']);
        });
    });
});
