/*
 * 実ブラウザーテストの共通部品
 *  - ローカル HTTP サーバー 2つ（127.0.0.1 と localhost = 別オリジン・別サイト）
 *  - 一時プロフィールへの実拡張機能の読み込み（Chromium / Edge）
 *  - ポップアップ・Service Worker・storage・バッジの操作と観測
 */
'use strict';

const base = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chromium, expect } = base;

const EXT_DIR = path.resolve(process.env.TEMPO_EXT_DIR || path.join(__dirname, '..'));
const SITE_DIR = path.join(__dirname, 'fixtures', 'site');
const MEDIA_DIR = path.join(__dirname, 'fixtures', 'media');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webm': 'video/webm'
};

// 期待値の比較用に、拡張機能と同じ翻訳カタログを読む
require(path.join(EXT_DIR, 'shared.js'));
require(path.join(EXT_DIR, 'i18n.js'));
const S = globalThis.TempoShared;
const I = globalThis.TempoI18n;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function createServer(config) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
      res.end(`window.TEMPO_TEST = ${JSON.stringify(config)};`);
      return;
    }
    const name = path.basename(url.pathname === '/' ? 'single.html' : url.pathname);
    const file = url.pathname.startsWith('/media/') ? path.join(MEDIA_DIR, name) : path.join(SITE_DIR, name);
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const headers = {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        'accept-ranges': 'bytes',
        'cache-control': 'no-store'
      };
      const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { ...headers, 'content-length': stat.size });
        fs.createReadStream(file).pipe(res);
      }
    });
  });
}

async function startServers() {
  const config = {};
  const a = createServer(config);
  const b = createServer(config);
  await new Promise((r) => a.listen(0, '127.0.0.1', r));
  await new Promise((r) => b.listen(0, '127.0.0.1', r));
  config.origin = `http://127.0.0.1:${a.address().port}`;
  config.crossOrigin = `http://localhost:${b.address().port}`;
  return {
    origin: config.origin,
    crossOrigin: config.crossOrigin,
    url: (p) => `${config.origin}/${p}`,
    close: () => Promise.all([a, b].map((s) => new Promise((r) => s.close(r))))
  };
}

// ---------------------------------------------------------------------------
// 拡張機能を読み込んだブラウザー
// ---------------------------------------------------------------------------

class Ext {
  constructor(context, id, channel, userDataDir) {
    this.context = context;
    this.id = id;
    this.channel = channel;
    this.userDataDir = userDataDir;
  }

  async worker() {
    const prefix = `chrome-extension://${this.id}/`;
    const found = this.context.serviceWorkers().find((w) => w.url().startsWith(prefix));
    if (found) return found;
    return this.context.waitForEvent('serviceworker', { predicate: (w) => w.url().startsWith(prefix), timeout: 15_000 });
  }

  /** Service Worker の大域で評価する（background.js の関数も呼べる）。 */
  async sw(fn, arg) {
    for (let attempt = 0; ; attempt += 1) {
      const worker = await this.worker();
      try {
        return await worker.evaluate(fn, arg);
      } catch (error) {
        // 拡張機能の再読み込み・worker 停止の直後は、新しい worker で評価し直す
        if (attempt >= 6 || !/closed|destroyed|Target|restarted/i.test(String(error.message))) throw error;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  async version() {
    return this.sw(() => {
      const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
      const ua = navigator.userAgent;
      const m = / Edg\/([\d.]+)/.exec(ua) || /Chrome\/([\d.]+)/.exec(ua);
      return { ua, version: m ? m[1] : '', brands: brands.map((b) => `${b.brand} ${b.version}`) };
    });
  }

  storage() {
    return this.sw(() => chrome.storage.local.get(null));
  }

  save(patch) {
    return this.sw((p) => enqueueSave(p), patch);
  }

  async open(url) {
    const page = await this.context.newPage();
    await page.goto(url);
    return page;
  }

  /**
   * ページのタブ ID。
   * content script のトップフレーム報告（文書の開始時刻）と照合する。報告が無いページ
   * （内部ページ・導入前から開いていたページ）は、前面にしてアクティブタブを問い合わせる。
   */
  async tabId(page) {
    await page.bringToFront();
    const startedAt = /^(https?|file):/.test(page.url())
      ? await page.evaluate(() => Math.round(performance.timeOrigin)).catch(() => null)
      : null;
    if (startedAt != null) {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const id = await this.sw((origin) => {
          for (const [tabId, entry] of tabCache) {
            const top = entry.frames.get(0);
            if (top && top.startedAt === origin) return tabId;
          }
          return null;
        }, startedAt).catch(() => null);
        if (id != null) return id;
        await page.waitForTimeout(100);
      }
    }
    let previous = null;
    for (let i = 0; i < 10; i += 1) {
      const id = await this.sw(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return tab && tab.id;
      });
      if (id != null && id === previous) return id;
      previous = id;
      await page.waitForTimeout(100);
    }
    return previous;
  }

  tabState(tabId) {
    return this.sw((id) => getTabState(id), tabId);
  }

  /** content script が動画を検出するまで待つ。 */
  async waitForVideos(tabId, count) {
    await expect.poll(async () => (await this.tabState(tabId)).videoCount, { timeout: 15_000 }).toBe(count);
  }

  badge(tabId) {
    return this.sw(async (id) => ({
      text: await chrome.action.getBadgeText({ tabId: id }),
      title: await chrome.action.getTitle({ tabId: id })
    }), tabId);
  }

  async openPopup(tabId, { waitState = true } = {}) {
    const popup = await this.context.newPage();
    await popup.setViewportSize({ width: 360, height: 600 });
    await popup.goto(`chrome-extension://${this.id}/popup.html?tabId=${tabId}`);
    await expect(popup.locator('#enabled')).toBeEnabled();
    if (waitState) await popup.waitForTimeout(150);
    return popup;
  }

  /** 一般ページを開いて動画検出まで待ち、ポップアップも開く。 */
  async setup(url, videos, { popup = true } = {}) {
    const page = await this.open(url);
    const tabId = await this.tabId(page);
    if (videos != null) await this.waitForVideos(tabId, videos);
    const pop = popup ? await this.openPopup(tabId) : null;
    return { page, tabId, popup: pop };
  }

  /** Service Worker から各フレームへ送ったメッセージの種類を記録する。 */
  /**
   * Service Worker から各フレームへ送ったメッセージの種類を記録する。
   * dropResponseFor: その種類の送信は届けるが、応答だけを失わせる。
   * dropTaggedReports: さらに、その送信の requestId 付きの上り報告も失わせる。
   */
  async recordSentMessages({ dropResponseFor, dropTaggedReports = false } = {}) {
    await this.sw(({ drop, dropReports }) => {
      self.__sent = [];
      self.__droppedIds = new Set();
      if (!self.__origSend) self.__origSend = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = (...args) => {
        const message = args[1] || {};
        self.__sent.push(message.type);
        const result = self.__origSend(...args);
        if (drop && message.type === drop) {
          self.__droppedIds.add(message.requestId);
          result.catch(() => {});
          return Promise.reject(new Error('simulated lost response'));
        }
        return result;
      };
      if (dropReports) {
        if (!self.__origHandleReport) self.__origHandleReport = handleReport;
        self.handleReport = (msg, sender) => {
          if (msg && msg.requestId && self.__droppedIds.has(msg.requestId)) return undefined;
          return self.__origHandleReport(msg, sender);
        };
      }
    }, { drop: dropResponseFor || null, dropReports: dropTaggedReports });
  }

  sentMessages() {
    return this.sw(() => self.__sent || []);
  }

  async browserSession() {
    if (!this._browserSession) this._browserSession = await this.context.browser().newBrowserCDPSession();
    return this._browserSession;
  }

  /**
   * ツールバーの拡張機能ボタンを押したのと同じ操作（CDP Extensions.triggerAction）。
   * 実際のポップアップが開き、そのタブに activeTab 権限が付く。
   */
  async triggerAction(page) {
    await page.bringToFront();
    const session = await this.browserSession();
    const url = page.url();
    const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const tab = targetInfos.find((info) => info.url === url);
    if (!tab) throw new Error(`tab target not found: ${url}`);
    await session.send('Extensions.triggerAction', { id: this.id, targetId: tab.targetId });
    await page.waitForTimeout(300);
  }

  /** onInstalled の初期値書き込みを待つ。 */
  async waitInstalled() {
    await expect.poll(async () => (await this.storage()).tempoSettings != null, { timeout: 30_000 }).toBe(true);
  }

  /** 起動後に拡張機能を導入する（CDP Extensions.loadUnpacked）。既に開いているタブには content script が無い。 */
  async install() {
    const session = await this.browserSession();
    const { id } = await session.send('Extensions.loadUnpacked', { path: this.extDir });
    this.id = id;
    await this.worker();
    await this.waitInstalled();
  }

  /** Service Worker を停止する（次のイベントで再起動し、メモリーは空になる）。 */
  async stopWorker(page) {
    await this.sw(() => { self.__alive = true; });
    const cdp = await this.context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await cdp.detach().catch(() => {});
  }

  async close() {
    await this.context.close().catch(() => {});
    fs.rm(this.userDataDir, { recursive: true, force: true }, () => {});
  }
}

/**
 * 一時プロフィールでブラウザーを起動し、拡張機能を読み込む。
 * options.deferred: 起動時には読み込まず、ext.install() で後から導入する
 *   （「拡張機能の導入・更新より前から開いていたページ」を再現する）。
 */
async function launchExtension(channel, options = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-profile-'));
  const extDir = options.extDir || EXT_DIR;
  // Google Chrome（正式版）は --load-extension を受け付けないので、起動直後に CDP で導入する
  const viaCdp = options.deferred || channel === 'chrome';
  // Extensions.triggerAction / loadUnpacked（CDP）に必要
  const args = ['--enable-unsafe-extension-debugging'];
  if (!viaCdp) args.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`);
  if (options.lang) args.push(`--lang=${options.lang}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel,
    headless: !process.env.HEADED,
    // 既定の --disable-extensions があると、後から導入・再読み込みした拡張機能が無効になる
    ignoreDefaultArgs: ['--disable-extensions'],
    // Playwright Test はページの言語を既定で en-US に固定するので、UI 言語と合わせる
    ...(options.lang ? { locale: options.lang } : {}),
    args,
    viewport: { width: 1280, height: 800 }
  });
  const ext = new Ext(context, null, channel, userDataDir);
  ext.extDir = extDir;
  if (viaCdp && !options.deferred) {
    await ext.install();
  } else if (!options.deferred) {
    let worker = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    ext.id = worker.url().split('/')[2];
    await ext.waitInstalled();
  }
  return ext;
}

// ---------------------------------------------------------------------------
// ページ側の観測
// ---------------------------------------------------------------------------

function rates(target) {
  return target.evaluate(() => [...document.querySelectorAll('video')].map((v) => Math.round(v.playbackRate * 1000) / 1000));
}

function frameByUrl(page, part) {
  return page.frames().find((f) => f.url().includes(part));
}

async function frameRates(page, part) {
  const frame = frameByUrl(page, part);
  if (!frame) return null;
  return rates(frame);
}

/** 表示中の動画上パネルの数（display:none は数えない）。 */
function visiblePanels(target) {
  return target.evaluate(() =>
    [...document.querySelectorAll('tempo-speed-panel')].filter((h) => getComputedStyle(h).display !== 'none').length
  );
}

function panel(target, index = 0) {
  return target.locator('tempo-speed-panel').nth(index);
}

const t = (lang, key, params) => I.t(lang, key, params);

// ---------------------------------------------------------------------------
// テスト用 fixture
// ---------------------------------------------------------------------------

const test = base.test.extend({
  browserChannel: ['chromium', { option: true }],
  site: [
    async ({}, use) => {
      const servers = await startServers();
      await use(servers);
      await servers.close();
    },
    { scope: 'worker' }
  ],
  ext: async ({ browserChannel }, use, testInfo) => {
    const ext = await launchExtension(browserChannel);
    const info = await ext.version().catch(() => ({ version: '?' }));
    testInfo.annotations.push({ type: 'browser', description: `${browserChannel} ${info.version}` });
    await use(ext);
    await ext.close();
  },
  /** 拡張機能を後から導入するブラウザー（ext.install() を呼ぶ） */
  lateExt: async ({ browserChannel }, use, testInfo) => {
    const ext = await launchExtension(browserChannel, { deferred: true });
    testInfo.annotations.push({ type: 'browser', description: `${browserChannel} (後から導入)` });
    await use(ext);
    await ext.close();
  },
  /** 日本語 UI で始める（仕様の基本文言） */
  ja: async ({ ext }, use) => {
    await ext.save({ language: 'ja' });
    await use('ja');
  }
});

module.exports = {
  test,
  expect,
  S,
  I,
  t,
  EXT_DIR,
  startServers,
  launchExtension,
  rates,
  frameByUrl,
  frameRates,
  visiblePanels,
  panel
};
