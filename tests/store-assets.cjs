/*
 * ストア掲載用の画像を実際の拡張機能から作る（store/images/ に保存）。
 *   npm run store:assets
 *
 * screenshot-<言語>-1.png  1280×800  ポップアップで今のタブの動画をまとめて変更
 * screenshot-<言語>-2.png  1280×800  動画上のパネル（詳細を開いた状態）
 * screenshot-<言語>-3.png  1280×800  折りたたみアイコン・OFF画面・12言語
 * promo-small-440x280.png  小さいプロモーション タイル
 * 第三者の動画・ロゴは使わず、テスト用動画（fixtures/media）だけを写す。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { startServers, launchExtension, panel, I } = require('./helpers.cjs');

const OUT = path.resolve(__dirname, '..', 'store', 'images');
const LANGS = ['ja', 'en'];

const COPY = {
  ja: {
    s1: ['ツールバーから、ページの動画をまとめて変速', '0.25〜16倍。プリセット 1・2・4・8・16倍と 0.01 単位の入力'],
    s2: ['動画の上の小さなパネルで、その動画だけを操作', '詳細を開けばスライダーと数値入力。キーボードでも操作できます'],
    s3: ['視聴の邪魔をしない淡いアイコン', 'OFF で元の速度に戻ります。12言語に対応'],
    folded: '折りたたみ時'
  },
  en: {
    s1: ['Change every video on the page from the toolbar', '0.25× to 16×. Presets 1, 2, 4, 8, 16× and 0.01-step input'],
    s2: ['A small panel on the video controls just that video', 'Open details for a slider and number input. Keyboard friendly'],
    s3: ['A faint icon that stays out of the way', 'Turn it OFF to restore the original speed. 12 languages'],
    folded: 'Collapsed'
  }
};

const BRAND_SVG = '<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M8 5 18 12 8 19Z" fill="#fff"/><path d="M4 6v12" stroke="#fff" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>';

function dataUrl(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function render(browser, html, width, height, file) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: file });
  await page.close();
  console.log(`作成: ${path.relative(path.resolve(__dirname, '..'), file)}`);
}

function frame(lang, title, sub, body) {
  const dir = I.dir(lang);
  return `<!doctype html><html lang="${I.htmlLang(lang)}" dir="${dir}"><head><meta charset="utf-8"><style>
    body{margin:0;width:1280px;height:800px;background:linear-gradient(135deg,#f7f9f8,#e3efec);font-family:"Segoe UI","Yu Gothic UI",Meiryo,sans-serif;color:#182b35;overflow:hidden}
    .top{position:absolute;inset:44px 56px auto 56px;display:flex;gap:16px;align-items:center}
    .mark{width:52px;height:52px;border-radius:15px;background:#163a3b;display:grid;place-items:center}
    .mark div{width:34px;height:34px}
    h1{margin:0;font-size:34px;font-weight:750;letter-spacing:.01em}
    p{margin:4px 0 0;font-size:18px;color:#4f625d}
    .stage{position:absolute;left:56px;right:56px;top:160px;bottom:40px}
    img{display:block}
    .shadow{box-shadow:0 12px 40px rgb(23 48 43 / 18%);border-radius:14px}
  </style></head><body>
    <div class="top"><div class="mark"><div>${BRAND_SVG}</div></div><div><h1>${title}</h1><p>${sub}</p></div></div>
    <div class="stage">${body}</div>
  </body></html>`;
}

async function popupShot(popup) {
  const height = await popup.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
  return popup.screenshot({ clip: { x: 0, y: 0, width: 360, height } });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const site = await startServers();
  const ext = await launchExtension('chromium');
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    for (const lang of LANGS) {
      const copy = COPY[lang];
      await ext.save({ language: lang, enabled: true, showOverlay: true, speed: 1 });

      // 1. ポップアップで一括変更
      const demo = await ext.open(site.url('demo.html'));
      await demo.setViewportSize({ width: 960, height: 640 });
      // 掲載画像をくっきりさせるため 2 倍の画素密度で描画する
      const cdp = await ext.context.newCDPSession(demo);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 2, mobile: false });
      const tabId = await ext.tabId(demo);
      await ext.waitForVideos(tabId, 1);
      await demo.evaluate(async () => {
        const v = document.getElementById('v1');
        v.currentTime = 2.2;
        await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      });
      const popup = await ext.openPopup(tabId);
      await popup.locator('.preset[data-speed="2"]').click();
      await popup.waitForTimeout(500);
      await popup.locator('#speedInput').fill('1.75');
      await popup.locator('#speedInput').press('Enter');
      await popup.waitForTimeout(700);
      await popup.locator('#speedInput').blur();
      await popup.mouse.move(350, 590);
      await popup.waitForTimeout(200);
      const popupOn = await popupShot(popup);
      await demo.bringToFront();
      await demo.mouse.move(950, 630);
      await demo.waitForTimeout(400);
      const pageShot = await demo.screenshot();
      await render(browser, frame(lang, copy.s1[0], copy.s1[1], `
        <img class="shadow" src="${dataUrl(pageShot)}" style="position:absolute;left:0;top:0;width:768px;height:512px">
        <img class="shadow" src="${dataUrl(popupOn)}" style="position:absolute;right:20px;top:0;width:360px">`),
      1280, 800, path.join(OUT, `screenshot-${lang}-1.png`));

      // 2. 動画上のパネル（詳細を開く）
      const p = panel(demo);
      await p.locator('.toggle').click();
      await demo.mouse.move(950, 630);
      await demo.waitForTimeout(400);
      const box = await p.locator('.panel').boundingBox();
      const videoBox = await demo.locator('#v1').boundingBox();
      const videoArea = await demo.screenshot({ clip: videoBox });
      const zoom = await demo.screenshot({ clip: { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 } });
      const zoomWidth = Math.round((box.width + 24) * 1.75);
      await render(browser, frame(lang, copy.s2[0], copy.s2[1], `
        <img class="shadow" src="${dataUrl(videoArea)}" style="position:absolute;left:0;top:40px;width:640px;height:${Math.round(640 * videoBox.height / videoBox.width)}px">
        <img class="shadow" src="${dataUrl(zoom)}" style="position:absolute;right:20px;top:0;width:${zoomWidth}px">`),
      1280, 800, path.join(OUT, `screenshot-${lang}-2.png`));

      // 3. 折りたたみ・OFF・言語
      await p.locator('.fold').click();
      await demo.mouse.move(950, 630);
      await demo.waitForTimeout(400);
      const fb = await p.locator('.panel').boundingBox();
      const folded = await demo.screenshot({ clip: { x: fb.x - 40, y: fb.y - 30, width: 260, height: 170 } });
      await ext.save({ enabled: false });
      const off = await ext.openPopup(tabId);
      const popupOff = await popupShot(off);
      await ext.save({ enabled: true });
      const langList = I.LANGUAGES.map(([, name]) => `<span>${name}</span>`).join('');
      await render(browser, frame(lang, copy.s3[0], copy.s3[1], `
        <div style="position:absolute;left:0;top:0;width:520px">
          <img class="shadow" src="${dataUrl(folded)}" style="width:520px;height:340px">
          <div style="margin-top:10px;font-size:15px;color:#4f625d">${copy.folded}</div>
          <div style="margin-top:22px;display:flex;flex-wrap:wrap;gap:8px;font-size:16px">${langList.replace(/<span>/g, '<span style="padding:5px 11px;border-radius:999px;background:#fff;border:1px solid #d6e2dd">')}</div>
        </div>
        <img class="shadow" src="${dataUrl(popupOff)}" style="position:absolute;right:20px;top:0;width:360px">`),
      1280, 800, path.join(OUT, `screenshot-${lang}-3.png`));

      for (const pg of [demo, popup, off]) await pg.close();
    }

    // 小さいプロモーション タイル（言語共通。製品名は英日併記）
    await render(browser, `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;width:440px;height:280px;background:linear-gradient(140deg,#163a3b,#0d5a52);font-family:"Segoe UI","Yu Gothic UI",Meiryo,sans-serif;color:#fff;display:flex;align-items:center;justify-content:center}
      .wrap{display:flex;align-items:center;gap:22px}
      .mark{width:96px;height:96px;border-radius:28px;background:rgba(255,255,255,.1);display:grid;place-items:center}
      .mark div{width:62px;height:62px}
      h1{margin:0;font-size:38px;font-weight:750;letter-spacing:.02em}
      p{margin:4px 0 0;font-size:17px;opacity:.85}
      .speeds{margin-top:12px;display:flex;gap:6px}
      .speeds span{font-size:13px;padding:3px 8px;border-radius:7px;background:rgba(255,255,255,.14)}
    </style></head><body><div class="wrap"><div class="mark"><div>${BRAND_SVG}</div></div>
      <div><h1>Tempo</h1><p>Video Playback Speed</p><p>動画再生速度変更</p>
      <div class="speeds"><span>0.25×</span><span>1×</span><span>2×</span><span>4×</span><span>16×</span></div></div></div></body></html>`,
    440, 280, path.join(OUT, 'promo-small-440x280.png'));
  } finally {
    await browser.close();
    await ext.close();
    await site.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
