// 受入項目 A12〜A15, A31, A32 と open Shadow DOM（設定・保存・自動適用）
'use strict';

const { test, expect, rates, frameByUrl, frameRates, visiblePanels, panel } = require('./helpers.cjs');

const preset = (popup, value) => popup.locator(`.preset[data-speed="${value}"]`);
const stored = async (ext) => (await ext.storage()).tempoSettings;

test('A12 表示設定OFFで全パネルが消え、速度とポップアップ操作は維持', async ({ ext, site, ja }) => {
  const a = await ext.setup(site.url('single.html'), 1, { popup: false });
  await expect(panel(a.page).locator('.panel')).toBeVisible();
  const b = await ext.setup(site.url('two-videos.html'), 3);
  await b.page.bringToFront();
  await expect(panel(b.page).locator('.panel')).toBeVisible();
  await b.popup.bringToFront();

  await b.popup.locator('#showOverlay').click();
  await expect.poll(async () => (await stored(ext)).showOverlay).toBe(false);
  await expect.poll(() => visiblePanels(a.page)).toBe(0);
  await expect.poll(() => visiblePanels(b.page)).toBe(0);
  await expect.poll(() => visiblePanels(frameByUrl(b.page, 'frame-video'))).toBe(0);

  await preset(b.popup, 2).click();
  await expect.poll(() => rates(b.page)).toEqual([2, 2]);
  await expect.poll(() => frameRates(b.page, 'frame-video')).toEqual([2]);
  await expect(b.popup.locator('#statusText')).toHaveText('ON · 2.00×');

  await a.page.bringToFront();
  await a.page.evaluate(() => addVideo());
  await ext.waitForVideos(a.tabId, 2);
  await a.page.waitForTimeout(300);
  expect(await visiblePanels(a.page)).toBe(0);
});

test('A13 記憶OFFは既存動画を変えず、新規動画・metadataでも自動適用しない。手動値は保存', async ({ ext, site, ja }) => {
  await ext.save({ speed: 3 });
  const { page, tabId, popup } = await ext.setup(site.url('single.html'), 1);
  await expect.poll(() => rates(page)).toEqual([3]);
  await page.evaluate(() => { document.getElementById('v1').playbackRate = 1.5; });

  await popup.locator('#rememberSpeed').click();
  await expect.poll(async () => (await stored(ext)).rememberSpeed).toBe(false);
  await page.waitForTimeout(300);
  expect(await rates(page)).toEqual([1.5]);

  await page.evaluate(() => addVideo());
  await ext.waitForVideos(tabId, 2);
  expect(await rates(page)).toEqual([1.5, 1]);
  await page.evaluate(() => resetSource('v2'));
  await page.waitForFunction(() => document.getElementById('v2').readyState >= 1);
  await page.waitForTimeout(400);
  expect(await rates(page)).toEqual([1.5, 1]);

  await preset(popup, 2).click();
  await expect.poll(() => rates(page)).toEqual([2, 2]);
  await expect.poll(async () => (await stored(ext)).speed).toBe(2);
  expect((await stored(ext)).rememberSpeed).toBe(false);
});

test('A14 記憶OFFのままOFF→ONで全タブの既存動画へ保存速度を適用', async ({ ext, site, ja }) => {
  await ext.save({ rememberSpeed: false, speed: 2.5 });
  const a = await ext.setup(site.url('single.html'), 1, { popup: false });
  const b = await ext.setup(site.url('two-videos.html'), 3);
  expect(await rates(a.page)).toEqual([1]);
  expect(await rates(b.page)).toEqual([1, 1]);

  await b.popup.locator('#enabled').click();
  await expect.poll(async () => (await stored(ext)).enabled).toBe(false);
  await b.popup.locator('#enabled').click();
  await expect.poll(async () => (await stored(ext)).enabled).toBe(true);
  await expect.poll(() => rates(a.page)).toEqual([2.5]);
  await expect.poll(() => rates(b.page)).toEqual([2.5, 2.5]);
  await expect.poll(() => frameRates(b.page, 'frame-video')).toEqual([2.5]);
  expect((await stored(ext)).rememberSpeed).toBe(false);
  await expect(b.popup.locator('#statusText')).toHaveText('ON · 2.50×');
});

test('A15 記憶ONなら追加動画とソース再設定時に保存速度を適用し、pause/resumeではサイトの速度を奪わない', async ({ ext, site, ja }) => {
  await ext.save({ speed: 2.5 });
  const { page, tabId } = await ext.setup(site.url('single.html'), 1, { popup: false });
  await expect.poll(() => rates(page)).toEqual([2.5]);
  await page.evaluate(() => addVideo());
  await ext.waitForVideos(tabId, 2);
  await expect.poll(() => rates(page)).toEqual([2.5, 2.5]);

  // ソース再設定: load() で既定速度へ戻った後、loadedmetadata で保存速度を適用
  await page.evaluate(() => resetSource('v1'));
  await expect.poll(() => rates(page)).toEqual([2.5, 2.5]);

  // サイトが 1.5 にした後の pause / resume では奪わない
  await page.evaluate(async () => {
    const v = document.getElementById('v1');
    v.playbackRate = 1.5;
    await v.play();
    v.pause();
    await v.play();
    v.pause();
  });
  await page.waitForTimeout(500);
  expect((await rates(page))[0]).toBe(1.5);
});

test('F24 一時的に外して付け直した動画も所有権を引き継ぎ、OFFで元の速度へ戻す', async ({ ext, site, ja }) => {
  const { page, tabId, popup } = await ext.setup(site.url('single.html'), 1);
  await page.evaluate(() => { document.getElementById('v1').playbackRate = 1.25; });
  await expect(popup.locator('#statusText')).toHaveText('ON · 1.25×');
  await popup.locator('.preset[data-speed="4"]').click();
  await expect.poll(() => rates(page)).toEqual([4]);
  await page.evaluate(async () => {
    const v = document.getElementById('v1');
    const parent = v.parentNode;
    v.remove();
    await new Promise((r) => setTimeout(r, 400));
    parent.append(v);
  });
  await ext.waitForVideos(tabId, 1);
  await popup.locator('#enabled').click();
  await expect.poll(() => rates(page)).toEqual([1.25]);

  // 外れている間に OFF になった場合も、付け直した時に戻す
  await popup.locator('#enabled').click();
  await expect.poll(async () => (await stored(ext)).enabled).toBe(true);
  await page.evaluate(() => { document.getElementById('v1').playbackRate = 1.5; });
  await expect(popup.locator('#statusText')).toHaveText('ON · 1.50×');
  await popup.locator('.preset[data-speed="8"]').click();
  await expect.poll(() => rates(page)).toEqual([8]);
  await page.evaluate(() => {
    window.__detached = document.getElementById('v1');
    window.__parent = window.__detached.parentNode;
    window.__detached.remove();
  });
  await page.waitForTimeout(400);
  await popup.locator('#enabled').click();
  await expect.poll(async () => (await stored(ext)).enabled).toBe(false);
  await page.evaluate(() => window.__parent.append(window.__detached));
  await expect.poll(() => rates(page)).toEqual([1.5]);
});

test('F24 open Shadow DOM: 初期・後から追加した host・監視中 root への追加を検出', async ({ ext, site, ja }) => {
  await ext.save({ speed: 2.5 });
  const { page, tabId } = await ext.setup(site.url('shadow.html'), 1, { popup: false });
  const shadowRates = () => page.evaluate(() => shadowRates());
  await expect.poll(shadowRates).toEqual({ s1: 2.5 });
  await page.evaluate(() => addShadowHost());
  await expect.poll(shadowRates).toEqual({ s1: 2.5, s3: 2.5 });
  await page.evaluate(() => addIntoRoot());
  await expect.poll(shadowRates).toEqual({ s1: 2.5, s1b: 2.5, s3: 2.5 });

  // 既存 host への後からの attachShadow は MutationObserver に現れないため、自動検出は保証しない。
  // ポップアップの照会・速度指示時（と読み込み完了時の照会）の再走査で検出する（制約として記録）。
  await page.evaluate(() => lateAttach());
  await ext.waitForVideos(tabId, 4);
  await expect.poll(async () => (await shadowRates()).s2).toBe(2.5);
});

test('A31 保存速度と表示設定などの同時更新を両方保持し、古い応答で最新の速度選択を戻さない', async ({ ext, site, ja }) => {
  const { page, popup } = await ext.setup(site.url('two-videos.html'), 3);
  await popup.evaluate(() => Promise.all([
    chrome.runtime.sendMessage({ type: 'TEMPO_SAVE_SETTINGS', patch: { speed: 3 } }),
    chrome.runtime.sendMessage({ type: 'TEMPO_SAVE_SETTINGS', patch: { showOverlay: false } }),
    chrome.runtime.sendMessage({ type: 'TEMPO_SAVE_SETTINGS', patch: { rememberSpeed: false } }),
    chrome.runtime.sendMessage({ type: 'TEMPO_SAVE_SETTINGS', patch: { language: 'en' } })
  ]));
  const all = await ext.storage();
  expect(all.tempoSettings).toEqual({ version: 1, enabled: true, speed: 3, showOverlay: false, rememberSpeed: false });
  expect(all.tempoLanguage).toBe('en');

  // 最初の速度指示の応答だけを遅らせる（2倍の応答が 8倍の後に届く）
  await ext.save({ language: 'ja', showOverlay: true });
  await popup.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message) => {
      const result = original(message);
      if (message && message.type === 'TEMPO_SET_TAB_SPEED' && message.speed === 2) {
        return result.then((value) => new Promise((r) => setTimeout(() => r(value), 1200)));
      }
      return result;
    };
  });
  await preset(popup, 2).click();
  await expect.poll(() => rates(page)).toEqual([2, 2]);
  await preset(popup, 8).click();
  await expect.poll(() => rates(page)).toEqual([8, 8]);
  await popup.waitForTimeout(1600);
  await expect(popup.locator('#speedInput')).toHaveValue('8.00');
  await expect(popup.locator('#statusText')).toHaveText('ON · 8.00×');
  await expect(preset(popup, 8)).toHaveAttribute('aria-pressed', 'true');
  expect((await stored(ext)).speed).toBe(8);
  expect(await rates(page)).toEqual([8, 8]);
});

test('A32 保存失敗を動画の正常通知で消さず、変更拒否も play/pause だけで消さない', async ({ ext, site, ja }) => {
  const { page, popup } = await ext.setup(site.url('single.html'), 1);
  await ext.sw(() => {
    self.__origSet = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = () => Promise.reject(new Error('simulated'));
  });
  await preset(popup, 2).click();
  await expect.poll(() => rates(page)).toEqual([2]);
  await expect(popup.locator('#noticeText')).toHaveText('設定を保存できませんでした。');
  expect((await stored(ext)).speed).toBe(1);
  await page.evaluate(async () => {
    const v = document.getElementById('v1');
    await v.play();
    v.pause();
    v.playbackRate = 2;
  });
  await popup.waitForTimeout(600);
  await expect(popup.locator('#noticeText')).toHaveText('設定を保存できませんでした。');

  // スイッチは保存済みの値へ戻る
  await popup.locator('#showOverlay').click();
  await expect(popup.locator('#showOverlay')).toBeChecked();
  await expect(popup.locator('#noticeText')).toHaveText('設定を保存できませんでした。');

  // 保存できるようになれば消える
  await ext.sw(() => { chrome.storage.local.set = self.__origSet; });
  await preset(popup, 4).click();
  await expect(popup.locator('#notice')).toBeHidden();
  await expect.poll(async () => (await stored(ext)).speed).toBe(4);

  // 変更拒否
  const r = await ext.setup(site.url('reject.html'), 1);
  await preset(r.popup, 4).click();
  await expect(r.popup.locator('#noticeText')).toHaveText('再生速度を変更できません。');
  await r.page.evaluate(async () => {
    const v = document.getElementById('v1');
    await v.play();
    v.pause();
    await v.play();
  });
  await r.popup.waitForTimeout(600);
  await expect(r.popup.locator('#noticeText')).toHaveText('再生速度を変更できません。');
  // 動画が消えたら解消（動画なしの案内へ）
  await r.page.evaluate(() => document.getElementById('v1').remove());
  await expect(r.popup.locator('#noticeText')).toHaveText('動画が見つかりません。');
});
