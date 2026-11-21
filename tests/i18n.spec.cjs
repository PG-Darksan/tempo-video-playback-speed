// 受入項目 A22〜A24（12言語・自動設定・RTL・画面サイズ・言語変更時の状態維持）
'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect, I, t, launchExtension, panel } = require('./helpers.cjs');

const SCREENS = path.join(__dirname, 'results', 'screens');

/** 360×600 に収まり、横にはみ出す要素がないこと。 */
async function expectFits(popup) {
  const m = await popup.evaluate(() => {
    const root = document.documentElement;
    const overflowing = [...document.querySelectorAll('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > 360.5 || r.left < -0.5);
      })
      .map((el) => el.id || el.className || el.tagName);
    const author = document.getElementById('author').getBoundingClientRect();
    return { width: root.scrollWidth, height: root.scrollHeight, overflowing, authorBottom: author.bottom };
  });
  expect(m.overflowing).toEqual([]);
  expect(m.width).toBeLessThanOrEqual(360);
  expect(m.height).toBeLessThanOrEqual(600);
  expect(m.authorBottom).toBeLessThanOrEqual(600);
}

async function shot(popup, name, testInfo) {
  fs.mkdirSync(SCREENS, { recursive: true });
  const file = path.join(SCREENS, `${testInfo.project.name}-${name}.png`);
  await popup.screenshot({ path: file });
}

test('A22 全12言語を選択・再表示して保存し、既存パネル・折りたたみ title・警告・バッジへ即時反映', async ({ ext, site }) => {
  const video = await ext.setup(site.url('single.html'), 1, { popup: false });
  await panel(video.page).locator('.fold').click();
  const none = await ext.setup(site.url('no-video.html'), 0);
  const restore = panel(video.page).locator('.restore');

  for (const lang of I.CODES) {
    await none.popup.locator('#language').selectOption(lang);
    await expect.poll(async () => (await ext.storage()).tempoLanguage).toBe(lang);
    await expect(none.popup.locator('html')).toHaveAttribute('lang', I.htmlLang(lang));
    await expect(none.popup.locator('#brand')).toHaveText(t(lang, 'extName'));
    await expect(none.popup.locator('#noticeText')).toHaveText(t(lang, 'msgNoVideo'));
    await expect(none.popup.locator('#showOverlayLabel')).toHaveText(t(lang, 'showOverlay'));
    await expect(none.popup.locator('#reset')).toHaveAttribute('aria-label', t(lang, 'resetLabel'));
    await expect(restore).toHaveAttribute('aria-label', t(lang, 'openController'));
    await expect(restore).toHaveAttribute('title', `${t(lang, 'openController')} · 1×`);
    await expect.poll(async () => (await ext.badge(video.tabId)).title).toBe(`${t(lang, 'extName')} · ON · 1×`);

    await none.popup.reload();
    await expect(none.popup.locator('#enabled')).toBeEnabled();
    await expect(none.popup.locator('#language')).toHaveValue(lang);
    await expect(none.popup.locator('#noticeText')).toHaveText(t(lang, 'msgNoVideo'));
  }
  // 未翻訳のキー名を表示していない
  const text = await none.popup.locator('body').innerText();
  expect(text).not.toMatch(/\b(msg|err)[A-Z]\w+/);
});

test('A23 自動設定と英語fallback・アラビア語RTL・数値のLTR・パネルのRTL', async ({ browserChannel, site }) => {
  // nl（オランダ語）はブラウザーにはあるが拡張機能は未対応 → 英語
  for (const [uiLang, expected] of [['de', 'de'], ['zh-TW', 'zh_TW'], ['pt-PT', 'pt_BR'], ['nl', 'en']]) {
    const ext = await launchExtension(browserChannel, { lang: uiLang });
    try {
      const resolved = await ext.sw(() => TempoI18n.resolve('auto'));
      expect(resolved).toBe(expected);
      const popup = await ext.openPopup(-1);
      await expect(popup.locator('html')).toHaveAttribute('lang', I.htmlLang(expected));
      await expect(popup.locator('#language')).toHaveValue('auto');
      await expect(popup.locator('#speedHeading')).toHaveText(t(expected, 'playbackSpeed'));
    } finally {
      await ext.close();
    }
  }

  const ext = await launchExtension(browserChannel);
  try {
    await ext.save({ language: 'ar' });
    const { page, popup } = await ext.setup(site.url('single.html'), 1);
    await expect(popup.locator('html')).toHaveAttribute('dir', 'rtl');
    const dirs = await popup.evaluate(() => Object.fromEntries(
      ['.value-row', '#slider', '.range-labels', '#presets', '#offValue', '#savedValue', '.header']
        .map((s) => [s, getComputedStyle(document.querySelector(s)).direction])
    ));
    expect(dirs).toEqual({
      '.value-row': 'ltr', '#slider': 'ltr', '.range-labels': 'ltr', '#presets': 'ltr',
      '#offValue': 'ltr', '#savedValue': 'ltr', '.header': 'rtl'
    });
    await page.bringToFront();
    const p = panel(page);
    await p.locator('.toggle').click();
    await expect(p.locator('.panel')).toHaveAttribute('dir', 'rtl');
    const overlay = await page.evaluate(() => {
      const root = document.querySelector('tempo-speed-panel').shadowRoot;
      const s = (q) => getComputedStyle(root.querySelector(q)).direction;
      return { row: s('.row'), slider: s('.slider'), presets: s('.presets'), number: s('.rate .num') };
    });
    expect(overlay).toEqual({ row: 'rtl', slider: 'rtl', presets: 'rtl', number: 'ltr' });
  } finally {
    await ext.close();
  }
});

test('A23 全言語の通常・OFF・警告・エラー画面が幅360px・高さ600px以内に収まる', async ({ ext, site }, testInfo) => {
  const video = await ext.setup(site.url('single.html'), 1, { popup: false });
  const none = await ext.setup(site.url('no-video.html'), 0, { popup: false });
  const reject = await ext.setup(site.url('reject.html'), 1, { popup: false });
  for (const lang of I.CODES) {
    await ext.save({ language: lang, enabled: true, speed: 1 });
    const on = await ext.openPopup(video.tabId);
    await expect(on.locator('#statusText')).toHaveText('ON · 1.00×');
    await expectFits(on);
    await shot(on, `A23-${lang}-on`, testInfo);

    const warn = await ext.openPopup(none.tabId);
    await expect(warn.locator('#noticeText')).toHaveText(t(lang, 'msgNoVideo'));
    await expectFits(warn);
    await shot(warn, `A23-${lang}-warning`, testInfo);

    const rejected = await ext.openPopup(reject.tabId);
    await rejected.locator('.preset[data-speed="16"]').click();
    await expect(rejected.locator('#noticeText')).toHaveText(t(lang, 'errCannotChange'));
    await expectFits(rejected);

    await on.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (m) => (m && m.type === 'TEMPO_SAVE_SETTINGS' ? Promise.reject(new Error('x')) : original(m));
    });
    await on.locator('#rememberSpeed').click();
    await expect(on.locator('#noticeText')).toHaveText(t(lang, 'errSaveSettings'));
    await expectFits(on);
    await shot(on, `A23-${lang}-error`, testInfo);

    await ext.save({ enabled: false });
    const off = await ext.openPopup(video.tabId);
    await expect(off.locator('#offValue')).toHaveText(t(lang, 'statusOff'));
    await expectFits(off);
    await shot(off, `A23-${lang}-off`, testInfo);
    for (const p of [on, warn, rejected, off]) await p.close();
  }
});

test('A24 入力途中・フォーカス・折りたたみを保って言語変更し、保存失敗時は旧選択へ戻りエラー', async ({ ext, site, ja }) => {
  const { page, popup } = await ext.setup(site.url('single.html'), 1);
  await page.bringToFront();
  await panel(page).locator('.fold').click();
  await popup.bringToFront();

  // ポップアップの入力途中に、別の画面から言語が変わる
  const input = popup.locator('#speedInput');
  await input.click();
  await input.fill('3.3');
  await ext.save({ language: 'en' });
  await expect(popup.locator('#speedHeading')).toHaveText('Playback speed');
  await expect(input).toHaveValue('3.3');
  await expect(input).toBeFocused();
  await expect(panel(page).locator('.restore')).toBeVisible();
  await expect(panel(page).locator('.restore')).toHaveAttribute('aria-label', 'Open controller');

  // 動画上パネルの入力途中でも同じ
  await page.bringToFront();
  const p = panel(page);
  await p.locator('.restore').click();
  await p.locator('.toggle').click();
  await p.locator('.input').click();
  await p.locator('.input').fill('5.5');
  await ext.save({ language: 'de' });
  await expect(p.locator('.toggle')).toHaveAttribute('aria-label', t('de', 'hideDetails'));
  await expect(p.locator('.input')).toHaveValue('5.5');
  expect(await page.evaluate(() => document.querySelector('tempo-speed-panel').shadowRoot.activeElement.className)).toBe('input');
  await expect(p.locator('.details')).toBeVisible();

  // 言語の保存失敗: 旧選択に戻してエラー
  await popup.bringToFront();
  await popup.reload();
  await expect(popup.locator('#enabled')).toBeEnabled();
  await expect(popup.locator('#language')).toHaveValue('de');
  await popup.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (m) =>
      (m && m.type === 'TEMPO_SAVE_SETTINGS' && m.patch && 'language' in m.patch ? Promise.reject(new Error('x')) : original(m));
  });
  await popup.locator('#language').selectOption('fr');
  await expect(popup.locator('#noticeText')).toHaveText(t('de', 'errSaveSettings'));
  await expect(popup.locator('#language')).toHaveValue('de');
  await expect(popup.locator('html')).toHaveAttribute('lang', 'de');
  expect((await ext.storage()).tempoLanguage).toBe('de');
});
