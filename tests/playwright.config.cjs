// 実ブラウザーテストの設定
//   chromium: Playwright 同梱の Chromium（新ヘッドレス）
//   edge:     インストール済みの Microsoft Edge（channel: msedge）
// 各テストは一時プロフィールへ実拡張機能を読み込み、ローカル HTTP の実動画を操作する。
'use strict';

const { defineConfig } = require('@playwright/test');

// 結果ファイル名: results/<対象>-<プロジェクト>.json（例: core-chromium.json）
const cliArgs = process.argv.slice(2);
const filters = cliArgs.filter((a, i) =>
  /^[a-z0-9_]+$/i.test(a) && a !== 'test' && !/^(-g|--grep|--timeout|--workers|-j)$/.test(cliArgs[i - 1] || ''));
const projectArg = cliArgs.find((a) => a.startsWith('--project='));
const resultName = `${filters.join('-') || 'all'}-${projectArg ? projectArg.split('=')[1] : 'all'}`;

module.exports = defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.cjs$/,
  timeout: 90_000,
  expect: { timeout: 6_000 },
  fullyParallel: true,
  workers: process.env.TEMPO_WORKERS ? Number(process.env.TEMPO_WORKERS) : 2,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: `results/${resultName}.json` }]],
  outputDir: 'test-results',
  projects: [
    { name: 'chromium', use: { browserChannel: 'chromium' } },
    { name: 'edge', use: { browserChannel: 'msedge' } },
    // インストール済みの Google Chrome（正式版）。拡張機能は CDP で読み込む
    { name: 'chrome', use: { browserChannel: 'chrome' } }
  ]
});
