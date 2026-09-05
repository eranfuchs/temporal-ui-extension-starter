// A lossless, bounded, pretty-printed JSON view for the payload panel.
// "Lossless" means every leaf is drawn from a raw substring of the original
// text (offset+length), never through JSON.parse/JSON.stringify or the
// scanner's own getTokenValue() — both INTERPRET the text (drop a string's
// escapes, round a 20-digit id, trim a number's trailing zeros). The scanner
// is used only to find where each token starts and ends; what it MEANS to a
// reader is decided here, from the raw substring, never from the scanner's
// own decoded value.
//
// FLAT, not a tree of collapsible nodes: every value is always fully drawn,
// indented two spaces per nesting level the same way JSON.stringify(x, null,
// 2) would lay it out, with a colour per token type and nothing to click.
//
// Bounded: a payload can be arbitrarily large or arbitrarily deep. Rather
// than truncate (which reads as a bug — "why does this array stop at item
// 40?"), exceeding either bound abandons the WHOLE render and falls back to
// plain text: a reader can still read every character, just without colour or
// indentation. Same fallback for anything the scanner reports as malformed,
// or for input that is not a single JSON value end to end (trailing content
// after the value closes) — a payload is not guaranteed to be JSON at all.
// A `/* comment */` inside it is also not JSON — see scanNext() below — for
// the same reason: this view exists to show a reader exactly what came back
// from a workflow, and a comment silently dropped from both the display and
// Copy is exactly the kind of loss "lossless" above promises will not happen.
//
// Why this file's own Parser walks the scanner's token stream instead of
// calling jsonc-parser's own parseTree(): parseTree() would materialise the
// ENTIRE syntax tree before anything here got a chance to check maxNodes or
// maxDepth, which defeats "Bounded" for exactly the adversarial-size input it
// exists to guard against — a payload big enough to matter is big enough that
// building the whole tree first is the expensive part. Rejecting comments is
// a one-line change to what this scanner-walk already does on every token; it
// is not a reason to trade the abort-before-fully-parsing property for it.

import { createScanner, ScanError, SyntaxKind, type JSONScanner } from 'jsonc-parser';

export interface JsonViewerLimits {
    maxNodes: number;
    maxDepth: number;
}

// Precedent: REQUEST_TIMEOUT_MS / MAX_CACHED_PAYLOADS in payloadClient.ts — a
// named, exported constant rather than a literal buried in the code, so a test
// can push a fixture past the bound without guessing the number.
export const DEFAULT_JSON_VIEWER_LIMITS: JsonViewerLimits = {
    maxNodes: 5_000,
    maxDepth: 40,
};

export const JSON_VIEW_CLASS = 'tuis-json-view';
export const JSON_FALLBACK_CLASS = 'tuis-json-fallback';

// Two spaces per nesting level, the same indent JSON.stringify(x, null, 2)
// would use — the point is to look like ordinary pretty-printed JSON.
const INDENT_UNIT = '  ';

// Thrown, never returned. Every call site that can fail is inside the try in
// renderJsonPayload(), and the one thing every failure has in common is "stop
// and fall back" — a single exception type keeps that decision in one place
// instead of every recursive call threading a result-or-null back up to it.
class JsonViewerAbort extends Error {}

export function renderJsonPayload(
    doc: Document,
    text: string,
    limits: JsonViewerLimits = DEFAULT_JSON_VIEWER_LIMITS,
): HTMLElement {
    try {
        const root = new Parser(doc, text, limits).parseDocument();
        const container = doc.createElement('div');
        container.className = JSON_VIEW_CLASS;
        container.appendChild(root);
        return container;
    } catch {
        return plainTextFallback(doc, text);
    }
}

function plainTextFallback(doc: Document, text: string): HTMLElement {
    const div = doc.createElement('div');
    div.className = JSON_FALLBACK_CLASS;
    div.textContent = text;
    return div;
}

function punct(doc: Document, text: string): HTMLElement {
    const span = doc.createElement('span');
    span.className = 'tuis-json-punct';
    span.textContent = text;
    return span;
}

// One JSONScanner over one text, walked exactly once, left to right — O(n) in
// the length of the payload, with no backtracking. Every method leaves `token`
// holding whatever comes AFTER what it just consumed, so no caller ever needs
// to re-scan to find out where it is.
class Parser {
    private readonly scanner: JSONScanner;
    private token: SyntaxKind;
    private nodeCount = 0;

    constructor(
        private readonly doc: Document,
        private readonly text: string,
        private readonly limits: JsonViewerLimits,
    ) {
        // ignoreTrivia: false — the scanner is asked to report whitespace and
        // comments as real tokens instead of silently swallowing both, because
        // scanNext() below needs to tell the two apart. `true` here is the exact
        // line that let a comment through the whole-JSON-only contract this file
        // promises.
        this.scanner = createScanner(text, /* ignoreTrivia */ false);
        this.token = this.scanNext();
    }

    parseDocument(): Node {
        const root = this.parseValue(0);
        if (this.token !== SyntaxKind.EOF) {
            throw new JsonViewerAbort('trailing content after the JSON value');
        }
        return root;
    }

    private parseValue(depth: number): Node {
        if (depth > this.limits.maxDepth) throw new JsonViewerAbort('max depth exceeded');
        this.countNode();
        switch (this.token) {
            case SyntaxKind.OpenBraceToken:
                return this.parseContainer(depth, true);
            case SyntaxKind.OpenBracketToken:
                return this.parseContainer(depth, false);
            case SyntaxKind.StringLiteral:
            case SyntaxKind.NumericLiteral:
            case SyntaxKind.NullKeyword:
            case SyntaxKind.TrueKeyword:
            case SyntaxKind.FalseKeyword:
                return this.parseLeaf();
            default:
                throw new JsonViewerAbort('expected a value');
        }
    }

    private parseLeaf(): HTMLElement {
        const span = this.doc.createElement('span');
        span.className = `tuis-json-tok ${leafTokenClass(this.token)}`;
        span.textContent = this.rawToken();
        this.advance();
        return span;
    }

    private parseContainer(depth: number, isObject: boolean): DocumentFragment {
        const closeToken = isObject ? SyntaxKind.CloseBraceToken : SyntaxKind.CloseBracketToken;
        const openGlyph = isObject ? '{' : '[';
        const closeGlyph = isObject ? '}' : ']';
        this.advance(); // consume the open brace/bracket

        const frag = this.doc.createDocumentFragment();
        frag.appendChild(punct(this.doc, openGlyph));

        const childIndent = INDENT_UNIT.repeat(depth + 1);
        if (this.token !== closeToken) {
            for (;;) {
                frag.appendChild(this.doc.createTextNode(`\n${childIndent}`));

                if (isObject) {
                    if (this.token !== SyntaxKind.StringLiteral) {
                        throw new JsonViewerAbort('expected a property name');
                    }
                    const key = this.doc.createElement('span');
                    key.className = 'tuis-json-key';
                    key.textContent = this.rawToken();
                    frag.appendChild(key);
                    this.advance();

                    // Cast, not a bare comparison: TS narrowed this.token to StringLiteral
                    // at the property-name check above and does not widen it back across
                    // the advance() call between there and here — a control-flow gap in
                    // how it tracks `this` properties across calls, not a real invariant.
                    if ((this.token as SyntaxKind) !== SyntaxKind.ColonToken) {
                        throw new JsonViewerAbort('expected a colon');
                    }
                    this.advance();
                    frag.appendChild(punct(this.doc, ': '));
                }

                frag.appendChild(this.parseValue(depth + 1));

                if (this.token === SyntaxKind.CommaToken) {
                    this.advance();
                    frag.appendChild(punct(this.doc, ','));
                    continue;
                }
                break;
            }
            frag.appendChild(this.doc.createTextNode(`\n${INDENT_UNIT.repeat(depth)}`));
        }

        if (this.token !== closeToken) throw new JsonViewerAbort('expected a closing brace or bracket');
        this.advance();
        frag.appendChild(punct(this.doc, closeGlyph));
        return frag;
    }

    private countNode(): void {
        this.nodeCount += 1;
        if (this.nodeCount > this.limits.maxNodes) throw new JsonViewerAbort('max node count exceeded');
    }

    private rawToken(): string {
        const offset = this.scanner.getTokenOffset();
        const length = this.scanner.getTokenLength();
        return this.text.substring(offset, offset + length);
    }

    private advance(): void {
        this.token = this.scanNext();
    }

    // With ignoreTrivia:false the scanner hands back whitespace and comments as
    // tokens of their own rather than absorbing them before this file ever sees
    // them. Whitespace is exactly as invisible to the grammar as it was before
    // this method loops past it; a comment is not whitespace — JSON has no
    // comment syntax — so it aborts the same way a stray character would.
    private scanNext(): SyntaxKind {
        for (;;) {
            const next = this.scanner.scan();
            if (this.scanner.getTokenError() !== ScanError.None) {
                throw new JsonViewerAbort('scan error');
            }
            if (next === SyntaxKind.LineCommentTrivia || next === SyntaxKind.BlockCommentTrivia) {
                throw new JsonViewerAbort('comments are not valid JSON');
            }
            if (next === SyntaxKind.Trivia || next === SyntaxKind.LineBreakTrivia) continue;
            return next;
        }
    }
}

function leafTokenClass(token: SyntaxKind): string {
    switch (token) {
        case SyntaxKind.StringLiteral:
            return 'tuis-json-string';
        case SyntaxKind.NumericLiteral:
            return 'tuis-json-number';
        case SyntaxKind.NullKeyword:
            return 'tuis-json-null';
        case SyntaxKind.TrueKeyword:
        case SyntaxKind.FalseKeyword:
            return 'tuis-json-bool';
        default:
            return '';
    }
}
