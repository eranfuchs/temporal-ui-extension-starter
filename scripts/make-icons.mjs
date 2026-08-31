#!/usr/bin/env node
// Generates public/icons/icon-{16,32,48,128}.png.
//
// Why generate rather than commit an image and be done: a PNG is the one file in
// a repository nobody can review. It cannot be diffed, and no scanner — not the
// leak gate in this repo, not any secret scanner — can read what is inside it.
// A drawing produced by 60 lines of arithmetic can be reviewed by reading the
// arithmetic.
//
// No dependencies: PNG is a container around a zlib stream, and Node ships zlib.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { discoverProjects, ROOT } from './projects.mjs';

const SIZES = [16, 32, 48, 128];

const BACKGROUND = [0x1e, 0x25, 0x30, 0xff]; // slate — no Temporal brand colour
const STROKE = [0xe6, 0xed, 0xf3, 0xff];

// ── Telling the projects apart ───────────────────────────────────────────────
//
// Several extensions from one repository, loaded at the same time, in a toolbar
// that shows them at 16px: one glyph for all of them means the only way to know
// which is which is to hover each in turn. So each project's icon carries its
// own NUMBER — the same number as its directory — and its own hue.
//
// Both are DERIVED from the directory name, not configured. Adding 04-whatever
// gets a numeral and a colour with no edit here, and the icon can never disagree
// with the directory it sits in, which a hand-maintained table eventually would.
//
// The number of the project, from its directory: "02-techniques" → "02".
// Anything unnumbered gets no numeral rather than a guessed one.
function projectNumber(id) {
    const match = /^(\d+)/.exec(id);
    return match ? match[1] : null;
}

// Hue by golden angle. 137.5° apart is the arrangement that stays maximally
// separated however many projects there turn out to be — no palette to extend,
// and no two adjacent projects landing on colours that look alike at 16px. The
// 35° offset keeps 01 and 02 (teal and magenta) away from the indigo/violet that
// reads as Temporal's own brand, which this repository does not borrow.
function accentOf(number) {
    return hslToRgba((35 + Number(number) * 137.5) % 360, 0.62, 0.6);
}

function hslToRgba(hue, saturation, lightness) {
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const sector = hue / 60;
    const second = chroma * (1 - Math.abs((sector % 2) - 1));
    const [r, g, b] =
        sector < 1
            ? [chroma, second, 0]
            : sector < 2
              ? [second, chroma, 0]
              : sector < 3
                ? [0, chroma, second]
                : sector < 4
                  ? [0, second, chroma]
                  : sector < 5
                    ? [second, 0, chroma]
                    : [chroma, 0, second];
    const base = lightness - chroma / 2;
    return [r, g, b].map((channel) => Math.round((channel + base) * 255)).concat(0xff);
}

// A 3×5 pixel font, digits only, one string per row. Small enough to be read as
// arithmetic — which is the whole reason the icons are generated rather than
// committed as images — and 3×5 is the smallest grid on which every digit is
// still distinguishable from every other.
const DIGITS = {
    0: ['###', '# #', '# #', '# #', '###'],
    1: [' # ', '## ', ' # ', ' # ', '###'],
    2: ['###', '  #', '###', '#  ', '###'],
    3: ['###', '  #', '###', '  #', '###'],
    4: ['# #', '# #', '###', '  #', '  #'],
    5: ['###', '#  ', '###', '  #', '###'],
    6: ['###', '#  ', '###', '# #', '###'],
    7: ['###', '  #', '  #', '  #', '  #'],
    8: ['###', '# #', '###', '# #', '###'],
    9: ['###', '# #', '###', '  #', '###'],
};

const GLYPH_WIDTH = 3;
const GLYPH_HEIGHT = 5;

// The glyph is the feature: a trunk with two branch arms.
function draw(size, number) {
    const pixels = new Uint8Array(size * size * 4);
    const put = (x, y, rgba) => {
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        const at = (y * size + x) * 4;
        pixels.set(rgba, at);
    };
    const fillRect = (x, y, w, h, rgba) => {
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(xx, yy, rgba);
    };

    // Rounded background.
    const radius = Math.round(size * 0.22);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = Math.min(x, size - 1 - x);
            const dy = Math.min(y, size - 1 - y);
            if (dx < radius && dy < radius) {
                const ex = radius - dx;
                const ey = radius - dy;
                if (ex * ex + ey * ey > radius * radius) continue; // leave transparent
            }
            put(x, y, BACKGROUND);
        }
    }

    const accent = number === null ? STROKE : accentOf(number);

    // AT THE SMALL SIZES, DRAW THE NUMBER AND NOTHING ELSE.
    //
    // The tree at 16px is three hairlines one pixel wide. It is not legible, and
    // it is identical in every project — so at the sizes Chrome actually puts in
    // the toolbar, where telling the extensions apart matters most, it conveys
    // nothing while using up the whole canvas. A favicon gets one idea; here the
    // number is the idea. 48 and 128 are the extensions page and the store
    // listing, which have room for both.
    if (size <= 32 && number !== null) {
        const scale = Math.max(2, Math.floor(size / 8));
        const textWidth = number.length * GLYPH_WIDTH * scale + (number.length - 1) * scale;
        drawNumber(
            put,
            number,
            Math.round((size - textWidth) / 2),
            Math.round((size - GLYPH_HEIGHT * scale) / 2),
            scale,
            accent,
        );
        return pixels;
    }

    const thickness = Math.max(1, Math.round(size / 16));
    // The tree is compressed into the upper left to leave the lower right for the
    // number badge; without that the last arm runs underneath it.
    const trunkX = Math.round(size * 0.24);
    const top = Math.round(size * 0.16);
    const bottom = Math.round(size * 0.56);
    const armEnd = Math.round(size * 0.6);
    const arm1 = Math.round(size * 0.36);

    fillRect(trunkX, top, thickness, bottom - top, STROKE); // trunk
    fillRect(trunkX, arm1, armEnd - trunkX, thickness, STROKE); // first child
    fillRect(trunkX, bottom - thickness, armEnd - trunkX, thickness, STROKE); // last child

    if (number !== null) {
        // A FILLED badge, not accent-coloured strokes on slate. A solid block of
        // colour survives being scaled down and being shown against an unknown
        // toolbar background; thin coloured strokes do not.
        const scale = Math.max(1, Math.round((size * 0.26) / GLYPH_HEIGHT));
        const pad = scale;
        const textWidth = number.length * GLYPH_WIDTH * scale + (number.length - 1) * scale;
        const badgeWidth = textWidth + pad * 2;
        const badgeHeight = GLYPH_HEIGHT * scale + pad * 2;
        const badgeX = size - badgeWidth - Math.max(1, Math.round(size * 0.04));
        const badgeY = size - badgeHeight - Math.max(1, Math.round(size * 0.04));
        fillRect(badgeX, badgeY, badgeWidth, badgeHeight, accent);
        // Digits knocked out of the badge in the background colour: readable on
        // any hue the golden angle produces, which digits in white would not be.
        drawNumber(put, number, badgeX + pad, badgeY + pad, scale, BACKGROUND);
    }

    return pixels;
}

// Digits at an integer scale, left to right, one column of gap between them.
function drawNumber(put, number, x, y, scale, rgba) {
    let cursor = x;
    for (const character of number) {
        const rows = DIGITS[character];
        if (rows) {
            rows.forEach((row, rowIndex) => {
                [...row].forEach((cell, columnIndex) => {
                    if (cell !== '#') return;
                    for (let dy = 0; dy < scale; dy++) {
                        for (let dx = 0; dx < scale; dx++) {
                            put(cursor + columnIndex * scale + dx, y + rowIndex * scale + dy, rgba);
                        }
                    }
                });
            });
        }
        cursor += (GLYPH_WIDTH + 1) * scale;
    }
}

// ── PNG container ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, pixels) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // colour type: RGBA
    header[10] = 0; // deflate
    header[11] = 0; // adaptive filtering
    header[12] = 0; // no interlace

    // One filter byte (0 = none) in front of every scanline.
    const stride = size * 4;
    const raw = Buffer.alloc((stride + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (stride + 1)] = 0;
        Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// One glyph per project, because the number and the hue come from the project.
// These files are therefore a declared FORK in scripts/lineage.json, not a shared
// file — extensions that look identical in a toolbar are indistinguishable
// exactly when it matters, which is while all of them are loaded.
const projects = discoverProjects().filter((project) => !project.incomplete);
if (projects.length === 0) {
    console.error('No projects found — nothing to write icons into.');
    process.exit(1);
}

for (const project of projects) {
    const number = projectNumber(project.id);
    const outDir = join(project.dir, 'public', 'icons');
    mkdirSync(outDir, { recursive: true });
    for (const size of SIZES) {
        const file = join(outDir, `icon-${size}.png`);
        writeFileSync(file, encodePng(size, draw(size, number)));
        console.log(`wrote ${relative(ROOT, file)}`);
    }
    const accent = number === null ? STROKE : accentOf(number);
    console.log(
        number === null
            ? `  ${project.id}: no number in the directory name — tree only, no numeral`
            : `  ${project.id}: numeral "${number}", accent rgb(${accent.slice(0, 3).join(' ')})`,
    );
}
