import type { WorkloadScenario } from '../benchmark-workloads.ts';

const STRING_PART_COUNT = 25_000;
const STRING_JOIN_REPEAT_COUNT = 64;
const STRING_REPEAT_COUNT = 4_000;
const STRING_PAD_COUNT = 4_000;
const ARRAY_LOCALE_STRING_COUNT = 8_000;
const STRING_CASE_COUNT = 8_000;
const TYPED_ARRAY_STRING_COUNT = 4_000;
const FROM_CHAR_CODE_COUNT = 8_000;
const STRING_REPLACE_COUNT = 8_000;
const UNICODE_JOIN_PART_COUNT = 7;

const STRING_PARTS = buildStringParts();
const ARRAY_LOCALE_STRING_VALUES = ['a', 'b', 'c', 'd'].map((value) => value.repeat(64));
const TYPED_ARRAY_JOIN_VALUES = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const TYPED_ARRAY_LOCALE_VALUES = Uint8Array.from({ length: 16 }, (_, index) => index + 1);

/** String and typed-array built-in workloads, including Unicode correctness checks. */
export const STRING_WORKLOADS: readonly WorkloadScenario[] = [
    {
        name: 'strings',
        area: 'String construction and joining',
        operationsPerSample: STRING_PART_COUNT,
        run: runStrings,
    },
    {
        name: 'string-construction',
        area: 'String part construction',
        operationsPerSample: STRING_PART_COUNT,
        run: runStringConstruction,
    },
    {
        name: 'string-join',
        area: 'Batched dense ASCII array joining',
        operationsPerSample: STRING_PART_COUNT * STRING_JOIN_REPEAT_COUNT,
        run: runStringJoin,
    },
    {
        name: 'string-radix-integer',
        area: 'Integer radix formatting',
        operationsPerSample: STRING_PART_COUNT,
        run: runStringRadixInteger,
    },
    {
        name: 'string-join-unicode',
        area: 'Unicode join correctness and code-unit behavior',
        operationsPerSample: UNICODE_JOIN_PART_COUNT,
        run: runStringJoinUnicode,
    },
    {
        name: 'string-repeat-ascii',
        area: 'Repeated ASCII string construction',
        operationsPerSample: STRING_REPEAT_COUNT,
        run: runStringRepeatASCII,
    },
    {
        name: 'string-pad-ascii',
        area: 'ASCII string padding at both ends',
        operationsPerSample: STRING_PAD_COUNT * 2,
        run: runStringPadASCII,
    },
    {
        name: 'array-to-locale-string-ascii',
        area: 'Locale string conversion for ASCII array elements',
        operationsPerSample: ARRAY_LOCALE_STRING_COUNT * ARRAY_LOCALE_STRING_VALUES.length,
        run: runArrayToLocaleStringASCII,
    },
    {
        name: 'string-case-ascii',
        area: 'ASCII string case conversion',
        operationsPerSample: STRING_CASE_COUNT * 2,
        run: runStringCaseASCII,
    },
    {
        name: 'typed-array-join-ascii',
        area: 'ASCII typed array joining',
        operationsPerSample: TYPED_ARRAY_STRING_COUNT * TYPED_ARRAY_JOIN_VALUES.length,
        run: runTypedArrayJoinASCII,
    },
    {
        name: 'typed-array-locale-ascii',
        area: 'ASCII typed array locale conversion',
        operationsPerSample: TYPED_ARRAY_STRING_COUNT * TYPED_ARRAY_LOCALE_VALUES.length,
        run: runTypedArrayLocaleASCII,
    },
    {
        name: 'string-from-char-code-ascii',
        area: 'ASCII multi-argument character code conversion',
        operationsPerSample: FROM_CHAR_CODE_COUNT,
        run: runStringFromCharCodeASCII,
    },
    {
        name: 'string-replace-ascii',
        area: 'ASCII string replace and replaceAll',
        operationsPerSample: STRING_REPLACE_COUNT * 2,
        run: runStringReplaceASCII,
    },
];

function runStrings(): number {
    const parts = buildStringParts();
    const joined = parts.join('|');
    return joined.length + joined.charCodeAt(joined.length - 1);
}

function runStringConstruction(): number {
    const parts = buildStringParts();
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first === undefined || last === undefined) return -1;
    return parts.length + first.length + last.length + first.charCodeAt(0) + last.charCodeAt(last.length - 1);
}

function runStringJoin(): number {
    let checksum = 0;
    for (let repeat = 0; repeat < STRING_JOIN_REPEAT_COUNT; repeat++) {
        const joined = STRING_PARTS.join('|');
        checksum += joined.length + joined.charCodeAt(joined.length - 1);
    }
    return checksum;
}

function runStringRadixInteger(): number {
    let checksum = 0;
    for (let index = 0; index < STRING_PART_COUNT; index++) {
        const text = index.toString(36);
        checksum = (checksum + text.length + text.charCodeAt(text.length - 1)) >>> 0;
    }

    for (const [value, radix, expected] of RADIX_STRING_CASES) {
        if (value.toString(radix) !== expected) return -1;
    }
    return checksum;
}

function runStringJoinUnicode(): number {
    const parts: (string | null | undefined | { toString: () => string })[] = ['before', 'é', '𐐷', undefined, null];
    parts[6] = {
        toString() {
            parts[0] = 'after';
            return 'later';
        },
    };

    if (parts.length !== UNICODE_JOIN_PART_COUNT) return -1;
    const joined = parts.join('·');
    if (joined !== 'before·é·𐐷····later') return -1;
    return joined.length + joined.charCodeAt(joined.length - 1);
}

function runStringRepeatASCII(): number {
    let checksum = 0;
    for (let index = 0; index < STRING_REPEAT_COUNT; index++) {
        const repeated = 'abcd'.repeat(128);
        checksum += repeated.length + repeated.charCodeAt(repeated.length - 1);
    }

    if ('é𐐷'.repeat(2) !== 'é𐐷é𐐷') return -1;
    return checksum;
}

function runStringPadASCII(): number {
    let checksum = 0;
    for (let index = 0; index < STRING_PAD_COUNT; index++) {
        const start = 'item-42'.padStart(256, '._');
        const end = 'item-42'.padEnd(256, '._');
        if (start.length !== 256 || end.length !== 256) return -1;
        checksum += start.length + start.charCodeAt(start.length - 1);
        checksum += end.length + end.charCodeAt(end.length - 1);
    }

    if ('x'.padStart(4, 'é') !== 'éééx') return -1;
    return checksum;
}

function runArrayToLocaleStringASCII(): number {
    let checksum = 0;
    for (let index = 0; index < ARRAY_LOCALE_STRING_COUNT; index++) {
        const converted = ARRAY_LOCALE_STRING_VALUES.toLocaleString();
        if (converted.length !== 259 || converted.slice(0, 2) !== 'aa') return -1;
        checksum += converted.length + converted.charCodeAt(converted.length - 1);
    }

    if (['é', '𐐷'].toLocaleString() !== 'é,𐐷') return -1;
    return checksum;
}

function runStringCaseASCII(): number {
    let checksum = 0;
    for (let index = 0; index < STRING_CASE_COUNT; index++) {
        const lower = 'STATIC HERMES STRING PATH 0123456789'.toLowerCase();
        const upper = 'static hermes string path 0123456789'.toUpperCase();
        if (lower !== 'static hermes string path 0123456789' || upper !== 'STATIC HERMES STRING PATH 0123456789') {
            return -1;
        }
        checksum += lower.length + upper.charCodeAt(0) + upper.charCodeAt(upper.length - 1);
    }

    return checksum;
}

function runTypedArrayJoinASCII(): number {
    let checksum = 0;
    for (let index = 0; index < TYPED_ARRAY_STRING_COUNT; index++) {
        const joined = TYPED_ARRAY_JOIN_VALUES.join('|');
        if (joined.length !== 86 || joined[0] !== '1' || !joined.endsWith('|32')) return -1;
        checksum += joined.length + joined.charCodeAt(joined.length - 1);
    }

    if (new Uint8Array([1, 2, 3]).join('λ') !== '1λ2λ3') return -1;
    return checksum;
}

function runTypedArrayLocaleASCII(): number {
    let checksum = 0;
    const originalToLocaleString = Number.prototype.toLocaleString;
    Number.prototype.toLocaleString = function () {
        return this.toString();
    };
    try {
        for (let index = 0; index < TYPED_ARRAY_STRING_COUNT; index++) {
            const converted = TYPED_ARRAY_LOCALE_VALUES.toLocaleString();
            if (converted !== '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16') return -1;
            checksum += converted.length + converted.charCodeAt(converted.length - 1);
        }
    } finally {
        Number.prototype.toLocaleString = originalToLocaleString;
    }

    return checksum;
}

function runStringFromCharCodeASCII(): number {
    let checksum = 0;
    for (let index = 0; index < FROM_CHAR_CODE_COUNT; index++) {
        const text = String.fromCharCode(80, 85, 77, 80, 75, 73, 78);
        if (text !== 'PUMPKIN') return -1;
        checksum += text.length + text.charCodeAt(text.length - 1);
    }

    if (String.fromCharCode(65, 128) !== 'A\u0080') return -1;
    return checksum;
}

function runStringReplaceASCII(): number {
    let checksum = 0;
    for (let index = 0; index < STRING_REPLACE_COUNT; index++) {
        const once = 'prefix-fast-path-fast'.replace('fast', 'FAST');
        const all = 'prefix-fast-path-fast'.replaceAll('fast', 'FAST');
        if (once !== 'prefix-FAST-path-fast' || all !== 'prefix-FAST-path-FAST') return -1;
        checksum += once.length + all.length + once.charCodeAt(7) + all.charCodeAt(20);
    }

    if ('AλB'.replace('A', 'X') !== 'XλB') return -1;
    return checksum;
}

const RADIX_STRING_CASES: readonly [number, number, string][] = [
    [0, 36, '0'],
    [35, 36, 'z'],
    [36, 36, '10'],
    [1, 2, '1'],
    [2, 2, '10'],
    [4, 2, '100'],
    [8, 2, '1000'],
    [-35, 36, '-z'],
    [-36, 36, '-10'],
    [-Number.MAX_SAFE_INTEGER, 36, '-2gosa7pa2gv'],
    [Number.MAX_SAFE_INTEGER, 36, '2gosa7pa2gv'],
    [-0, 36, '0'],
    [0.5, 2, '0.1'],
    [10.5, 2, '1010.1'],
    [Number.MAX_SAFE_INTEGER + 1, 36, '2gosa7pa2gw'],
];

function buildStringParts(): string[] {
    const parts = new Array<string>(STRING_PART_COUNT);
    for (let index = 0; index < parts.length; index++) {
        parts[index] = `${index.toString(36)}:${String.fromCharCode(65 + (index % 26))}`;
    }
    return parts;
}
