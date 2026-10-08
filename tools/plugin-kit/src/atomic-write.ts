import type { Descriptor } from 'wasi:filesystem/types@0.2.3';
import { wasiErrorCode } from './wasi-error.ts';
import { disposeWasiResource } from './wasi-resource.ts';

let nextTempId = 0;

/** Replaces a file through an exclusively created sibling, preserving existing temporary files. */
export function atomicWrite(root: Descriptor, path: string, content: Uint8Array): void {
    let temp: string;
    let file: Descriptor;
    for (;;) {
        temp = `${path}.tmp.${nextTempId++}`;
        try {
            file = root.openAt({}, temp, { create: true, exclusive: true }, { write: true });
            break;
        } catch (error) {
            if (wasiErrorCode(error) !== 'exist') throw error;
        }
    }
    try {
        try {
            for (let offset = 0; offset < content.length; ) {
                const written = file.write(content.subarray(offset), BigInt(offset));
                if (written === 0n) throw new Error(`could not write ${path}`);
                const remaining = content.length - offset;
                if (written > BigInt(remaining)) throw new Error(`invalid write result for ${path}`);
                offset += Number(written);
            }
        } catch (error) {
            try {
                disposeWasiResource(file);
            } catch {
                // Preserve the write failure if closing the descriptor also fails.
            }
            throw error;
        }
        disposeWasiResource(file);
        root.renameAt(temp, root, path);
    } catch (error) {
        try {
            root.unlinkFileAt(temp);
        } catch {
            // Preserve the write or rename failure if cleanup is also denied.
        }
        throw error;
    }
}
