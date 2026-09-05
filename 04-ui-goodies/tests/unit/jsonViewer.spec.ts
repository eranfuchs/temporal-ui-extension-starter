// @vitest-environment jsdom
//
// src/payloads/jsonViewer.ts — the lossless, bounded, flat JSON view.
//
// "Lossless" is the property that matters most and is easiest to lose by
// accident: a single JSON.parse, or a call to the scanner's own decoded
// getTokenValue(), would round a 20-digit id or collapse an escape sequence
// without ever failing a type check. Every test in the first section exists to
// catch exactly that kind of regression — one that a naive re-render or a
// "simplify this with JSON.parse" edit would introduce silently.
//
// "Bounded" is the second property: a payload is not guaranteed to be small,
// shallow, or even JSON at all, and exceeding either bound — or hitting
// anything the scanner calls malformed — has to fall back to the WHOLE text as
// plain text, never a partially-built tree.

import { describe, expect, it } from 'vitest';

import {
    JSON_FALLBACK_CLASS,
    JSON_VIEW_CLASS,
    renderJsonPayload,
    type JsonViewerLimits,
} from '../../src/payloads/jsonViewer';

function tree(text: string, limits?: JsonViewerLimits): HTMLElement {
    return renderJsonPayload(document, text, limits);
}

describe('losslessness', () => {
    it('renders a 20-digit id unchanged — a number too big for IEEE-754 to hold exactly', () => {
        const text = '{"accountId":12345678901234567890}';
        const node = tree(text);

        const leaf = node.querySelector('.tuis-json-number')!;
        expect(leaf.textContent).toBe('12345678901234567890');
    });

    it('renders a high-precision decimal without trimming trailing digits', () => {
        const text = '{"rate":0.100000000000000005551}';
        const node = tree(text);

        expect(node.querySelector('.tuis-json-number')!.textContent).toBe('0.100000000000000005551');
    });

    it('renders a string escape literally, never decoded to the character it means', () => {
        // getTokenValue() would decode this to "café". The raw substring — what a
        // reader would see in the original payload — keeps the backslash.
        const text = '{"greeting":"caf\\u00e9"}';
        const node = tree(text);

        const leaf = node.querySelector('.tuis-json-string')!;
        expect(leaf.textContent).toBe('"caf\\u00e9"');
        expect(leaf.textContent).not.toContain('café');
    });

    it('keeps the quotes as part of the rendered string leaf', () => {
        const text = '{"name":"ok"}';
        const node = tree(text);

        expect(node.querySelector('.tuis-json-string')!.textContent).toBe('"ok"');
    });

    it('renders a bare scalar document the same way, with no surrounding object', () => {
        const node = tree('12345678901234567890');

        expect(node.className).toBe(JSON_VIEW_CLASS);
        expect(node.querySelector('.tuis-json-number')!.textContent).toBe('12345678901234567890');
    });
});

describe('flat, non-collapsible rendering', () => {
    it('renders no <details> or <summary> — nothing here is collapsible', () => {
        const node = tree('{"a":1,"list":[1,2],"empty":{}}');

        expect(node.querySelector('details')).toBeNull();
        expect(node.querySelector('summary')).toBeNull();
    });

    it('pretty-prints with a newline and a two-space indent per nesting level', () => {
        const node = tree('{"outer":{"inner":1}}');

        expect(node.textContent).toContain('\n  "outer"');
        expect(node.textContent).toContain('\n    "inner"');
    });

    it('closes an empty container on the same line, with nothing indented inside it', () => {
        const node = tree('{"empty":{}}');

        expect(node.textContent).toContain('"empty": {}');
    });

    it('reconstructs exactly the original token stream once whitespace is stripped', () => {
        // The renderer inserts indentation and nothing else — every other
        // character it draws (braces, the colon, the comma, every leaf) comes
        // from the source text. Stripping every character it could have
        // inserted has to land back on the original, punctuation and all — the
        // same losslessness guarantee as the section above, checked for the
        // whole render instead of one leaf.
        const text = '{"a":1,"list":[1,2],"nested":{"b":"caf\\u00e9"},"empty":{}}';
        const node = tree(text);

        expect(node.textContent!.replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
    });
});

describe('bounded fallback', () => {
    it('falls back to plain text, byte for byte, when the node count is exceeded', () => {
        const text = '{"a":1,"b":2,"c":3}';
        const node = tree(text, { maxNodes: 2, maxDepth: 40 });

        expect(node.className).toBe(JSON_FALLBACK_CLASS);
        expect(node.textContent).toBe(text);
        expect(node.querySelector('details')).toBeNull();
    });

    it('falls back to plain text when nesting exceeds the depth limit', () => {
        const text = '{"a":{"b":{"c":1}}}';
        const node = tree(text, { maxNodes: 5_000, maxDepth: 1 });

        expect(node.className).toBe(JSON_FALLBACK_CLASS);
        expect(node.textContent).toBe(text);
    });

    it('never returns a partial tree — a payload just past the bound still falls back whole', () => {
        // One object over the limit, not wildly over: the case most likely to
        // tempt a "just truncate" implementation instead of an abandon-and-fallback
        // one.
        const text = '{"a":1,"b":2,"c":3,"d":4}';
        const node = tree(text, { maxNodes: 4, maxDepth: 40 });

        expect(node.className).toBe(JSON_FALLBACK_CLASS);
        expect(node.textContent).toBe(text);
    });
});

describe('malformed or non-JSON input', () => {
    it('falls back to plain text for input that is not JSON at all', () => {
        const text = 'this is a log line, not a payload';
        const node = tree(text);

        expect(node.className).toBe(JSON_FALLBACK_CLASS);
        expect(node.textContent).toBe(text);
    });

    it('falls back to plain text for trailing content after the value closes', () => {
        // A payload is not guaranteed to be a single JSON value end to end.
        const text = '{"a":1} trailing garbage';
        const node = tree(text);

        expect(node.className).toBe(JSON_FALLBACK_CLASS);
        expect(node.textContent).toBe(text);
    });

    it('falls back to plain text for a truncated document', () => {
        const text = '{"a":';
        const node = tree(text);

        expect(node.className).toBe(JSON_FALLBACK_CLASS);
        expect(node.textContent).toBe(text);
    });

    it('falls back to plain text for an empty string', () => {
        const node = tree('');

        expect(node.className).toBe(JSON_FALLBACK_CLASS);
        expect(node.textContent).toBe('');
    });
});

describe('comments are not valid JSON', () => {
    // jsonc-parser's scanner treats /* */ and // as trivia by default and skips
    // straight past them — which is correct for its own JSONC use case, but wrong
    // here: a comment silently vanishing from the display and from Copy is
    // exactly the kind of loss "lossless" above promises will not happen. Each
    // case below is the same input a comment-tolerant reading would accept
    // without complaint; every one has to fall back to the whole text unchanged.

    it('rejects a block comment before the value, falling back byte for byte', () => {
        const text = '/*hidden*/{"a":1}';
        const node = tree(text);

        expect(node.className).toBe(JSON_FALLBACK_CLASS);
        expect(node.textContent).toBe(text);
    });

    it('rejects a block comment embedded inside the value, falling back byte for byte', () => {
        const text = '{"a":/*hidden*/1}';
        const node = tree(text);

        expect(node.className).toBe(JSON_FALLBACK_CLASS);
        expect(node.textContent).toBe(text);
        expect(node.querySelector('.tuis-json-number')).toBeNull();
    });

    it('rejects a line comment after the value, falling back byte for byte', () => {
        const text = '{"a":1} // trailing';
        const node = tree(text);

        expect(node.className).toBe(JSON_FALLBACK_CLASS);
        expect(node.textContent).toBe(text);
    });

    it('still accepts valid JSON with no comments in it — the positive control', () => {
        // Without this, the three tests above could pass for the wrong reason: a
        // renderer that rejected everything, comment or not, would also be green.
        const text = '{"a":1,"b":[2,3]}';
        const node = tree(text);

        expect(node.className).toBe(JSON_VIEW_CLASS);
        expect(node.querySelector('.tuis-json-number')!.textContent).toBe('1');
    });
});
