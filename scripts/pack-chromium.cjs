#!/usr/bin/env node
'use strict';
// Chrome ウェブストア / Microsoft Edge アドオン提出用および配布用のフォルダーと ZIP を作る (依存パッケージなし)。
// scripts/package.ps1 と同等の成果物を Windows / macOS / Linux のいずれでも生成できる。
//   node scripts/pack-chromium.cjs
//
// 作るもの（dist/ 以下）:
//   Tempo/                    直下に manifest.json がある拡張機能フォルダー（「パッケージ化されていない拡張機能を読み込む」用）
//   Tempo-Chrome-Edge.zip     Tempo フォルダーを格納した配布用 ZIP
//   Tempo-webstore.zip        Chrome ウェブストア / Edge アドオンへのアップロード用（ZIP 直下に manifest.json）
//   Tempo-<version>-chrome-edge.zip  バージョン番号付きのストア提出用 ZIP（内容は Tempo-webstore.zip と同一）

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist');
const folderName = 'Tempo';
const work = path.join(outDir, folderName);

const FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'shared.js',
  'i18n.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'README.md'
];
const LOCALES = ['ja', 'en', 'ko', 'zh_CN', 'zh_TW', 'es', 'fr', 'de', 'pt_BR', 'ru', 'hi', 'ar'];
const ICONS = ['icon16.png', 'icon32.png', 'icon48.png', 'icon128.png'];

/* ------------------------------------------------------------ ZIP */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/* ------------------------------------------------------------ main */

function build() {
  execFileSync(process.execPath, [path.join(__dirname, 'build-i18n.cjs'), '--check'], { stdio: 'inherit' });

  const rels = [
    ...FILES,
    ...LOCALES.map((l) => `_locales/${l}/messages.json`),
    ...ICONS.map((i) => `icons/${i}`)
  ].sort();

  const entries = [];
  for (const rel of rels) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      throw new Error(`ファイルがありません: ${rel}`);
    }
    entries.push([rel, fs.readFileSync(full)]);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

  fs.rmSync(work, { recursive: true, force: true });
  for (const [rel, data] of entries) {
    const dest = path.join(work, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }

  const folderZip = path.join(outDir, 'Tempo-Chrome-Edge.zip');
  const storeZip = path.join(outDir, 'Tempo-webstore.zip');
  const versionedStoreZip = path.join(outDir, `Tempo-${manifest.version}-chrome-edge.zip`);

  const storeBuf = zip(entries);
  fs.writeFileSync(folderZip, zip(entries.map(([rel, data]) => [`${folderName}/${rel}`, data])));
  fs.writeFileSync(storeZip, storeBuf);
  fs.writeFileSync(versionedStoreZip, storeBuf);

  console.log(`Version ${manifest.version} / ${entries.length} files`);
  console.log(`作成: ${path.relative(root, work)}/`);
  console.log(`作成: ${path.relative(root, folderZip)}`);
  console.log(`作成: ${path.relative(root, storeZip)}`);
  console.log(`作成: ${path.relative(root, versionedStoreZip)}`);
}

build();
