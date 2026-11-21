// 受入項目 A35（配布 ZIP）と、外部送信・遠隔コードの静的確認（F23）
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, rates, EXT_DIR, launchExtension } = require('./helpers.cjs');

const DIST = path.join(EXT_DIR, 'dist');
const LOCALES = ['ja', 'en', 'ko', 'zh_CN', 'zh_TW', 'es', 'fr', 'de', 'pt_BR', 'ru', 'hi', 'ar'];
const FORBIDDEN = /(^|\/)(node_modules|tests|scripts|dist|results|test-results)(\/|$)|\.webm$|package(-lock)?\.json$|\.cjs$|\.ps1$/;

function powershell(args) {
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8' });
}

/** ZIP のエントリー名一覧（.NET で読む）。 */
function zipEntries(zip) {
  const out = powershell([
    '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead('${zip}'); try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() }`
  ]);
  return out.split(/\r?\n/).filter(Boolean);
}

function expand(zip) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-zip-'));
  powershell(['-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`]);
  return dir;
}

test.describe.configure({ mode: 'serial' });

test('A35 ZIPを新規展開して読み込め、12カタログ・アイコン・資料が揃い、開発依存を含まない', async ({ browserChannel, site }) => {
  powershell(['-File', path.join(EXT_DIR, 'scripts', 'package.ps1')]);
  const zip = path.join(DIST, 'Tempo-Chrome-Edge.zip');
  const storeZip = path.join(DIST, 'Tempo-webstore.zip');

  const entries = zipEntries(zip);
  expect(entries.every((e) => e.startsWith('Tempo/'))).toBe(true);
  expect(entries.some((e) => e.includes('\\'))).toBe(false);
  expect(entries.filter((e) => FORBIDDEN.test(e))).toEqual([]);
  for (const required of ['manifest.json', 'background.js', 'content.js', 'shared.js', 'i18n.js', 'popup.html', 'popup.css', 'popup.js', 'README.md',
    'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
    ...LOCALES.map((l) => `_locales/${l}/messages.json`)]) {
    expect(entries).toContain(`Tempo/${required}`);
  }
  expect(entries.filter((e) => e.startsWith('Tempo/_locales/') && e.endsWith('/messages.json'))).toHaveLength(12);

  // ストア用は ZIP 直下に manifest.json
  const storeEntries = zipEntries(storeZip);
  expect(storeEntries).toContain('manifest.json');
  expect(storeEntries.map((e) => `Tempo/${e}`).sort()).toEqual([...entries].sort());

  // 新しく展開したフォルダーを読み込んで実際に動かす
  const dir = expand(zip);
  const extDir = path.join(dir, 'Tempo');
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.version).toBe('1.5.3');
  expect(manifest.minimum_chrome_version).toBe('119');
  expect(manifest.permissions).toEqual(['storage', 'activeTab']);
  expect(manifest.host_permissions).toBeUndefined();
  const ext = await launchExtension(browserChannel, { extDir });
  try {
    await ext.save({ language: 'ja' });
    const { page, popup } = await ext.setup(site.url('single.html'), 1);
    await popup.locator('.preset[data-speed="2"]').click();
    await expect.poll(() => rates(page)).toEqual([2]);
    await expect(popup.locator('#statusText')).toHaveText('ON · 2.00×');
  } finally {
    await ext.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F23 実行時に外部へ送信せず、遠隔コード・外部ライブラリーを使わない（静的確認）', async () => {
  const files = ['background.js', 'content.js', 'shared.js', 'i18n.js', 'popup.js', 'popup.html', 'popup.css'];
  for (const file of files) {
    const text = fs.readFileSync(path.join(EXT_DIR, file), 'utf8');
    expect(text, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts\s*\(\s*['"]https?:|\beval\s*\(|new\s+Function\s*\(/);
    expect(text, file).not.toMatch(/<script[^>]+src=["']https?:|@import\s+url\(["']?https?:/);
    const urls = (text.match(/https?:\/\/[^\s'"`)<]+/g) || []).filter((u) => !u.startsWith('http://www.w3.org/'));
    expect(urls.every((u) => u.startsWith('https://hisator-notebook.com')), `${file}: ${urls.join(', ')}`).toBe(true);
  }
});
