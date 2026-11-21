'use strict';
// Firefox アドオン (addons.mozilla.org) 提出用のフォルダーと ZIP を作る (依存パッケージなし)。
// Chrome / Edge 用のソースはそのまま残し、 コピーに Firefox 向けの差分だけを当てる。
//   node tools/pack-firefox.cjs   (gesture)
//   node scripts/pack-firefox.cjs (speed)
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CONFIG = require('./firefox.config.cjs');

const root = path.resolve(__dirname, '..');
const src = path.join(root, CONFIG.source);
const outDir = path.join(root, 'dist');
const work = path.join(outDir, CONFIG.folderName);

// OneDrive やエクスプローラーが作る管理用ファイルは含めない
const IGNORE = /(^|\/)(\.[^/]*|desktop\.ini|thumbs\.db)$/i;

function list(dir, base = '') {
  const items = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${d.name}` : d.name;
    if (IGNORE.test(rel)) continue;
    if (d.isDirectory()) items.push(...list(path.join(dir, d.name), rel));
    else items.push(rel);
  }
  return items.sort();
}

/* ------------------------------------------------------------ manifest */

function firefoxManifest(m) {
  const out = { ...m };
  delete out.minimum_chrome_version;
  // Firefox はイベントページ (background.scripts) で動く。 service_worker の importScripts の代わりに順に読み込む。
  out.background = { scripts: CONFIG.backgroundScripts };
  if (Array.isArray(out.content_scripts)) {
    out.content_scripts = out.content_scripts.map((cs) => {
      const c = { ...cs };
      delete c.match_origin_as_fallback; // Chrome 専用キー
      return c;
    });
  }
  out.browser_specific_settings = {
    gecko: {
      id: CONFIG.geckoId,
      strict_min_version: '140.0',
      // 新規提出で必須。 個人データを一切収集しないことの申告
      data_collection_permissions: { required: ['none'] }
    }
  };
  return out;
}

/* ------------------------------------------------------------ 置換 */

function patchFile(rel, text) {
  for (const p of CONFIG.patches.filter((x) => x.file === rel)) {
    const count = text.split(p.find).length - 1;
    if (count !== (p.count || 1)) {
      throw new Error(`${rel}: 置換元が ${p.count || 1} 個の想定で ${count} 個でした → ${p.find.slice(0, 60)}`);
    }
    text = text.split(p.find).join(p.replace);
  }
  return text;
}

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
  const files = list(src).filter((rel) => CONFIG.include(rel));
  if (!files.includes('manifest.json')) throw new Error('manifest.json がありません');
  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  for (const s of CONFIG.backgroundScripts) if (!files.includes(s)) throw new Error(`background のファイルがありません: ${s}`);

  const entries = [];
  for (const rel of files) {
    let data = fs.readFileSync(path.join(src, rel));
    if (rel === 'manifest.json') {
      data = Buffer.from(JSON.stringify(firefoxManifest(manifest), null, 2) + '\n', 'utf8');
    } else if (/\.(js|html|css|json)$/i.test(rel)) {
      data = Buffer.from(patchFile(rel, data.toString('utf8')), 'utf8');
    }
    entries.push([rel, data]);
  }
  const unused = CONFIG.patches.filter((p) => !files.includes(p.file));
  if (unused.length) throw new Error(`対象ファイルがありません: ${unused.map((p) => p.file).join(', ')}`);

  fs.rmSync(work, { recursive: true, force: true });
  for (const [rel, data] of entries) {
    const dest = path.join(work, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  const zipPath = path.join(outDir, `${CONFIG.zipName}-${manifest.version}-firefox.zip`);
  fs.writeFileSync(zipPath, zip(entries));
  console.log(`作成: ${path.relative(root, work)}/ (${entries.length} files)`);
  console.log(`作成: ${path.relative(root, zipPath)}`);
}

build();
