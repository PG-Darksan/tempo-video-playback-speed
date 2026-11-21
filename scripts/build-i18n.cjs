#!/usr/bin/env node
/*
 * 翻訳カタログの生成と整合チェック
 *
 *   node scripts/build-i18n.cjs          _locales から i18n.js の組み込みカタログを生成
 *   node scripts/build-i18n.cjs --check  生成せずに検査だけ行い、i18n.js が最新かも確認
 *
 * 検査内容: 12言語のディレクトリー、キー集合の一致、空文字・キー名そのままの訳、
 * プレースホルダーの一致、manifest の参照キー、名前・説明の文字数。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOCALES_DIR = path.join(ROOT, '_locales');
const I18N_FILE = path.join(ROOT, 'i18n.js');
const MANIFEST_FILE = path.join(ROOT, 'manifest.json');
const REFERENCE = 'en';
const LOCALES = ['ja', 'en', 'ko', 'zh_CN', 'zh_TW', 'es', 'fr', 'de', 'pt_BR', 'ru', 'hi', 'ar'];
const BEGIN = '// BEGIN GENERATED CATALOGS (node scripts/build-i18n.cjs)';
const END = '// END GENERATED CATALOGS';
const LIMITS = { extName: 75, actionTitle: 75, extDescription: 132 };

const checkOnly = process.argv.includes('--check');
const errors = [];

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) errors.push(`${rel(file)}: BOM を含めないでください`);
  return JSON.parse(text.replace(/^﻿/, ''));
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function placeholdersIn(message) {
  return [...String(message).matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1].toLowerCase()).sort();
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// 1. 読み込み
const catalogs = {};
const actualDirs = fs.existsSync(LOCALES_DIR)
  ? fs.readdirSync(LOCALES_DIR).filter((d) => fs.statSync(path.join(LOCALES_DIR, d)).isDirectory())
  : [];
for (const dir of actualDirs) {
  if (!LOCALES.includes(dir)) errors.push(`_locales/${dir}: 対応言語にないディレクトリーです`);
}
for (const locale of LOCALES) {
  const file = path.join(LOCALES_DIR, locale, 'messages.json');
  if (!fs.existsSync(file)) {
    errors.push(`${rel(file)}: ありません`);
    continue;
  }
  try {
    catalogs[locale] = readJson(file);
  } catch (e) {
    errors.push(`${rel(file)}: JSON を読めません (${e.message})`);
  }
}

const reference = catalogs[REFERENCE];
if (!reference) {
  errors.push(`基準言語 ${REFERENCE} のカタログがありません`);
} else {
  const refKeys = Object.keys(reference);

  // 2. 各言語の検査
  for (const locale of LOCALES) {
    const catalog = catalogs[locale];
    if (!catalog) continue;
    const where = `_locales/${locale}/messages.json`;
    const keys = Object.keys(catalog);
    const missing = refKeys.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !refKeys.includes(k));
    if (missing.length) errors.push(`${where}: キー不足 ${missing.join(', ')}`);
    if (extra.length) errors.push(`${where}: 余分なキー ${extra.join(', ')}`);

    for (const key of keys) {
      const entry = catalog[key];
      if (!/^[A-Za-z0-9_]+$/.test(key)) errors.push(`${where}: キー名 ${key} に使えない文字があります`);
      if (!entry || typeof entry.message !== 'string') {
        errors.push(`${where}: ${key} に message がありません`);
        continue;
      }
      const message = entry.message;
      if (message.trim() === '') errors.push(`${where}: ${key} が空です`);
      if (message.trim() === key) errors.push(`${where}: ${key} がキー名のままです`);
      if (LIMITS[key] && [...message].length > LIMITS[key]) {
        errors.push(`${where}: ${key} が ${LIMITS[key]} 文字を超えています (${[...message].length})`);
      }
      const refEntry = reference[key];
      if (!refEntry) continue;
      const used = placeholdersIn(message);
      const refUsed = placeholdersIn(refEntry.message);
      if (!sameList(used, refUsed)) {
        errors.push(`${where}: ${key} のプレースホルダーが基準と違います (${used.join(',') || 'なし'} / 基準 ${refUsed.join(',') || 'なし'})`);
      }
      const declared = Object.keys(entry.placeholders || {}).map((k) => k.toLowerCase()).sort();
      const refDeclared = Object.keys(refEntry.placeholders || {}).map((k) => k.toLowerCase()).sort();
      if (!sameList(declared, refDeclared)) {
        errors.push(`${where}: ${key} の placeholders 定義が基準と違います`);
      }
      for (const name of used) {
        if (!declared.includes(name)) errors.push(`${where}: ${key} の $${name.toUpperCase()}$ が placeholders にありません`);
      }
    }
  }

  // 3. manifest の参照キー
  try {
    const manifest = readJson(MANIFEST_FILE);
    if (manifest.default_locale !== REFERENCE) errors.push(`manifest.json: default_locale は ${REFERENCE} にしてください`);
    const text = JSON.stringify(manifest);
    for (const m of text.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) {
      if (!m[1].startsWith('@@') && !refKeys.includes(m[1])) errors.push(`manifest.json: __MSG_${m[1]}__ がカタログにありません`);
    }
  } catch (e) {
    errors.push(`manifest.json を読めません (${e.message})`);
  }
}

// 4. i18n.js の言語一覧と生成範囲
const source = fs.readFileSync(I18N_FILE, 'utf8');
const languageCodes = [...source.matchAll(/^\s*\['([A-Za-z_]+)',\s*'[^']*'\]/gm)].map((m) => m[1]);
if (!sameList(languageCodes, LOCALES)) {
  errors.push(`i18n.js: LANGUAGES の並び (${languageCodes.join(',')}) がスクリプトの言語一覧と違います`);
}
const begin = source.indexOf(BEGIN);
const end = source.indexOf(END);
if (begin < 0 || end < begin) errors.push('i18n.js: 生成範囲の目印がありません');

if (errors.length) {
  console.error(`翻訳カタログに問題があります (${errors.length} 件):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

// 5. 生成
const order = Object.keys(reference);
const embedded = {};
for (const locale of LOCALES) {
  embedded[locale] = {};
  for (const key of order) embedded[locale][key] = catalogs[locale][key].message;
}
const indent = source.slice(source.lastIndexOf('\n', begin) + 1, begin);
const body = `const CATALOGS = ${JSON.stringify(embedded, null, 2)};`
  .split('\n')
  .map((line) => indent + line)
  .join('\n');
const generated = source.slice(0, begin) + BEGIN + '\n' + body + '\n' + indent + source.slice(end);

if (checkOnly) {
  if (generated !== source) {
    console.error('i18n.js の組み込みカタログが _locales と一致しません。node scripts/build-i18n.cjs を実行してください。');
    process.exit(1);
  }
  console.log(`OK: ${LOCALES.length} 言語 × ${order.length} キー。i18n.js は最新です。`);
} else {
  if (generated !== source) fs.writeFileSync(I18N_FILE, generated, 'utf8');
  console.log(`生成しました: ${LOCALES.length} 言語 × ${order.length} キー → i18n.js`);
}
