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

// The glyph is the feature: a trunk with two branch arms.
function draw(size) {
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

    const thickness = Math.max(1, Math.round(size / 16));
    const trunkX = Math.round(size * 0.3);
    const top = Math.round(size * 0.2);
    const bottom = Math.round(size * 0.74);
    const armEnd = Math.round(size * 0.74);
    const arm1 = Math.round(size * 0.44);

    fillRect(trunkX, top, thickness, bottom - top, STROKE); // trunk
    fillRect(trunkX, arm1, armEnd - trunkX, thickness, STROKE); // first child
    fillRect(trunkX, bottom - thickness, armEnd - trunkX, thickness, STROKE); // last child

    return pixels;
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

// The same glyph into every project. They are separate extensions and each needs
// its own copy under public/icons — the lineage gate expects those copies to be
// byte-identical, which they are because they come from one run of this script.
const encoded = new Map(SIZES.map((size) => [size, encodePng(size, draw(size))]));

const projects = discoverProjects().filter((project) => !project.incomplete);
if (projects.length === 0) {
    console.error('No projects found — nothing to write icons into.');
    process.exit(1);
}

for (const project of projects) {
    const outDir = join(project.dir, 'public', 'icons');
    mkdirSync(outDir, { recursive: true });
    for (const size of SIZES) {
        const file = join(outDir, `icon-${size}.png`);
        writeFileSync(file, encoded.get(size));
        console.log(`wrote ${relative(ROOT, file)}`);
    }
}
