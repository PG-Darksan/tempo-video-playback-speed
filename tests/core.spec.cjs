// 受入項目 A01〜A11, A16, A17, A25〜A30, A33, A34（基本動作・通信・表示判定）
'use strict';

const { test, expect, rates, frameByUrl, frameRates, visiblePanels, panel } = require('./helpers.cjs');

const preset = (popup, value) => popup.locator(`.preset[data-speed="${value}"]`);
const savedSpeed = async (ext) => (await ext.storage()).tempoSettings.speed;
const FORBIDDEN = ['未確認', '復元', '確認できません'];

async function expectNoNotice(popup) {
  await expect(popup.locator('#notice')).toBeHidden();
  await expect(popup.locator('#reloadButton')).toBeHidden();
}

async function expectCleanOff(popup) {
  await expect(popup.locator('#statusText')).toHaveText('OFF');
  await expect(popup.locator('#offView')).toBeVisible();
  await expect(popup.locator('#onView')).toBeHidden();
  await expect(popup.locator('#reset')).toBeHidden();
  await expectNoNotice(popup);
  const text = await popup.locator('body').innerText();
  for (const word of FORBIDDEN) expect(text).not.toContain(word);
}

test('A01 新規プロフィールの初期値5項目と1倍で開始', async ({ ext, site }) => {
  const stored = await ext.storage();
  expect(stored.tempoSettings).toEqual({ version: 1, enabled: true, speed: 1, showOverlay: true, rememberSpeed: true });
  expect(stored.tempoLanguage).toBe('auto');
  const { page, popup } = await ext.setup(site.url('single.html'), 1);
  expect(await rates(page)).toEqual([1]);
  await expect(popup.locator('#enabled')).toBeChecked();
  await expect(popup.locator('#showOverlay')).toBeChecked();
  await expect(popup.locator('#rememberSpeed')).toBeChecked();
  await expect(popup.locator('#language')).toHaveValue('auto');
  await expect(popup.locator('#speedInput')).toHaveValue('1.00');
  await expect(popup.locator('#statusText')).toHaveText('ON · 1.00×');
});

test('A02 1.23 を Enter・blur で確定し、Enter 後の blur で二重指示しない', async ({ ext, site, ja }) => {
  const { page, popup } = await ext.setup(site.url('single.html'), 1);
  await ext.recordSentMessages();
  const input = popup.locator('#speedInput');
  await input.fill('1.23');
  await input.press('Enter');
  await expect.poll(() => rates(page)).toEqual([1.23]);
  await input.blur();
  await popup.waitForTimeout(600);
  expect((await ext.sentMessages()).filter((m) => m === 'TEMPO_SET_SPEED')).toHaveLength(1);
  await expect.poll(() => savedSpeed(ext)).toBe(1.23);
  await expect(input).toHaveValue('1.23');

  await input.fill('1.5');
  await input.blur();
  await expect.poll(() => rates(page)).toEqual([1.5]);
  await expect.poll(() => savedSpeed(ext)).toBe(1.5);
  expect((await ext.sentMessages()).filter((m) => m === 'TEMPO_SET_SPEED')).toHaveLength(2);
});

test('A03 空欄・0.24・16.01・非数値は適用も保存もせず入力エラー', async ({ ext, site, ja }) => {
  const { page, popup } = await ext.setup(site.url('single.html'), 1);
  await ext.recordSentMessages();
  const input = popup.locator('#speedInput');
  for (const bad of ['', '0.24', '16.01', 'abc']) {
    await input.fill(bad);
    await input.press('Enter');
    await expect(popup.locator('#noticeText')).toHaveText('0.25〜16の数値を入力してください。');
    await expect(popup.locator('#notice')).toHaveClass(/error/);
    await expect(input).toHaveAttribute('aria-invalid', 'true');
  }
  await input.blur();
  await popup.waitForTimeout(400);
  expect(await rates(page)).toEqual([1]);
  expect(await savedSpeed(ext)).toBe(1);
  expect(await ext.sentMessages()).not.toContain('TEMPO_SET_SPEED');
});

test('A04 スライダー0.05刻み・増減0.25・上下限・5プリセット・リセット', async ({ ext, site, ja }) => {
  const { page, popup } = await ext.setup(site.url('single.html'), 1);
  const slider = popup.locator('#slider');
  await expect(slider).toHaveAttribute('step', '0.05');
  await expect(slider).toHaveAttribute('min', '0.25');
  await expect(slider).toHaveAttribute('max', '16');
  await expect(popup.locator('.preset')).toHaveText(['1×', '2×', '4×', '8×', '16×']);

  await popup.locator('#plus').click();
  await expect.poll(() => rates(page)).toEqual([1.25]);
  await popup.locator('#minus').click();
  await popup.locator('#minus').click();
  await expect.poll(() => rates(page)).toEqual([0.75]);
  await expect(popup.locator('#speedInput')).toHaveValue('0.75');

  await preset(popup, 16).click();
  await expect.poll(() => rates(page)).toEqual([16]);
  await expect(popup.locator('#plus')).toBeDisabled();
  await expect(preset(popup, 16)).toHaveAttribute('aria-pressed', 'true');
  await expect(preset(popup, 1)).toHaveAttribute('aria-pressed', 'false');

  await popup.locator('#speedInput').fill('0.25');
  await popup.locator('#speedInput').press('Enter');
  await expect.poll(() => rates(page)).toEqual([0.25]);
  await expect(popup.locator('#minus')).toBeDisabled();
  await expect(popup.locator('#plus')).toBeEnabled();

  await popup.locator('#reset').click();
  await expect.poll(() => rates(page)).toEqual([1]);
  await expect(preset(popup, 1)).toHaveAttribute('aria-pressed', 'true');

  await slider.fill('2.35');
  await expect.poll(() => rates(page)).toEqual([2.35]);
  await slider.focus();
  await popup.keyboard.press('ArrowRight');
  await expect.poll(() => rates(page)).toEqual([2.4]);
  await expect.poll(() => savedSpeed(ext)).toBe(2.4);

  // 連続操作でも直前の応答でスライダー値が巻き戻らない
  await popup.keyboard.press('ArrowRight');
  await popup.keyboard.press('ArrowRight');
  await expect.poll(() => rates(page)).toEqual([2.5]);
  await expect.poll(() => savedSpeed(ext)).toBe(2.5);

  // 入力途中や空欄のまま別ボタンを押しても段ズレや誤確定を起こさない
  await popup.locator('#speedInput').click();
  await popup.locator('#speedInput').fill('9');
  await popup.locator('#plus').click();
  await expect.poll(() => rates(page)).toEqual([2.75]);
  await page.bringToFront();
  const p = panel(page, 0);
  await p.locator('.toggle').click();
  await p.locator('.input').click();
  await p.locator('.input').fill('');
  await p.locator('.preset[data-speed="2"]').click();
  await expect.poll(() => rates(page)).toEqual([2]);
  await expect(p.locator('.error')).toBeHidden();
});

test('A05 同タブの2動画と別オリジン iframe に届き、トップに動画がなくても成功', async ({ ext, site, ja }) => {
  const a = await ext.setup(site.url('two-videos.html'), 3);
  expect(frameByUrl(a.page, 'frame-video').url()).toContain(site.crossOrigin);
  await preset(a.popup, 2).click();
  await expect.poll(() => rates(a.page)).toEqual([2, 2]);
  await expect.poll(() => frameRates(a.page, 'frame-video')).toEqual([2]);
  await expect(a.popup.locator('#statusText')).toHaveText('ON · 2.00×');
  await expectNoNotice(a.popup);

  const b = await ext.setup(site.url('frame-only.html'), 1);
  await preset(b.popup, 4).click();
  await expect.poll(() => frameRates(b.page, 'frame-video')).toEqual([4]);
  await expect(b.popup.locator('#statusText')).toHaveText('ON · 4.00×');
  await expectNoNotice(b.popup);
});

test('A06 動画上で1個を2.55倍にしても同ページの別動画・別タブは変わらない', async ({ ext, site, ja }) => {
  const other = await ext.setup(site.url('single.html'), 1, { popup: false });
  const a = await ext.setup(site.url('two-videos.html'), 3, { popup: false });
  const p = panel(a.page, 0);
  await expect(p.locator('.panel')).toBeVisible();
  await p.locator('.toggle').click();
  await p.locator('.input').fill('2.55');
  await p.locator('.input').press('Enter');
  await expect.poll(() => rates(a.page)).toEqual([2.55, 1]);
  expect(await frameRates(a.page, 'frame-video')).toEqual([1]);
  expect(await rates(other.page)).toEqual([1]);
  await expect(p.locator('.rate')).toHaveText('2.55×');
  await expect.poll(() => savedSpeed(ext)).toBe(2.55);
  await a.page.waitForTimeout(300);
  expect(await rates(other.page)).toEqual([1]);
});

test('A07 他タブの保存通知だけでは既存動画とポップアップの実速度表示が変わらない', async ({ ext, site, ja }) => {
  const a = await ext.setup(site.url('two-videos.html'), 3);
  await expect(a.popup.locator('#statusText')).toHaveText('ON · 1.00×');
  const b = await ext.setup(site.url('single.html'), 1, { popup: false });
  await panel(b.page, 0).locator('.plus').click();
  await expect.poll(() => rates(b.page)).toEqual([1.25]);
  await expect.poll(() => savedSpeed(ext)).toBe(1.25);
  await a.popup.bringToFront();
  await a.popup.waitForTimeout(300);
  expect(await rates(a.page)).toEqual([1, 1]);
  expect(await frameRates(a.page, 'frame-video')).toEqual([1]);
  await expect(a.popup.locator('#speedInput')).toHaveValue('1.00');
  await expect(a.popup.locator('#statusText')).toHaveText('ON · 1.00×');
});

test('A08 元1.25倍→4倍→8倍→OFFで1.25倍に戻り、保存速度8倍を維持', async ({ ext, site, ja }) => {
  const { page, popup } = await ext.setup(site.url('single.html'), 1);
  await page.evaluate(() => { document.getElementById('v1').playbackRate = 1.25; });
  await expect(popup.locator('#statusText')).toHaveText('ON · 1.25×');
  await preset(popup, 4).click();
  await expect.poll(() => rates(page)).toEqual([4]);
  await preset(popup, 8).click();
  await expect.poll(() => rates(page)).toEqual([8]);
  await popup.locator('#enabled').click();
  await expect.poll(() => rates(page)).toEqual([1.25]);
  const stored = await ext.storage();
  expect(stored.tempoSettings.enabled).toBe(false);
  expect(stored.tempoSettings.speed).toBe(8);
  await expect(popup.locator('#savedValue')).toHaveText('8.00×');
});

test('A09 4倍適用後にサイト側で1.75倍にすると OFF でも1.75倍を維持', async ({ ext, site, ja }) => {
  const { page, popup } = await ext.setup(site.url('single.html'), 1);
  await preset(popup, 4).click();
  await expect.poll(() => rates(page)).toEqual([4]);
  await page.evaluate(() => { document.getElementById('v1').playbackRate = 1.75; });
  await page.waitForTimeout(200);
  await popup.locator('#enabled').click();
  await expect.poll(async () => (await ext.storage()).tempoSettings.enabled).toBe(false);
  await page.waitForTimeout(300);
  expect(await rates(page)).toEqual([1.75]);
});

test('A10 OFFで全タブのパネルとバッジが消え、中央OFFとON時保存速度だけを表示', async ({ ext, site, ja }) => {
  const a = await ext.setup(site.url('single.html'), 1, { popup: false });
  await expect(panel(a.page, 0).locator('.panel')).toBeVisible();
  const b = await ext.setup(site.url('two-videos.html'), 3);
  await b.page.bringToFront();
  await expect(panel(b.page, 0).locator('.panel')).toBeVisible();
  await b.popup.bringToFront();
  await preset(b.popup, 4).click();
  await expect.poll(async () => (await ext.badge(b.tabId)).text).toBe('4×');
  await expect.poll(async () => (await ext.badge(a.tabId)).text).toBe('1×');

  await b.popup.locator('#enabled').click();
  await expect.poll(() => visiblePanels(a.page)).toBe(0);
  await expect.poll(() => visiblePanels(b.page)).toBe(0);
  await expect.poll(() => visiblePanels(frameByUrl(b.page, 'frame-video'))).toBe(0);
  await expect.poll(async () => (await ext.badge(a.tabId)).text).toBe('');
  await expect.poll(async () => (await ext.badge(b.tabId)).text).toBe('');
  await expect(b.popup.locator('#offValue')).toHaveText('OFF');
  await expect(b.popup.locator('#savedValue')).toHaveText('4.00×');
  await expectCleanOff(b.popup);
});

test('A11 OFF中は動画なし・OFF処理中・再表示でも未確認や復元の注記を出さない', async ({ ext, site, ja }) => {
  const noVideo = await ext.setup(site.url('no-video.html'), 0, { popup: false });
  const video = await ext.setup(site.url('single.html'), 1, { popup: false });

  // OFF 処理中: 保存を遅らせる
  const popup = await ext.openPopup(video.tabId);
  await ext.sw(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    self.__restoreSet = () => { chrome.storage.local.set = original; };
    chrome.storage.local.set = (items) => new Promise((r) => setTimeout(r, 800)).then(() => original(items));
  });
  await popup.locator('#enabled').click();
  await expect(popup.locator('#statusText')).toHaveText('OFF');
  await expect(popup.locator('#enabled')).toBeDisabled();
  await expectCleanOff(popup);
  await expect.poll(async () => (await ext.storage()).tempoSettings.enabled).toBe(false);
  await ext.sw(() => self.__restoreSet());
  await expectCleanOff(popup);

  for (const tabId of [noVideo.tabId, video.tabId]) {
    const p = await ext.openPopup(tabId);
    await p.waitForTimeout(500);
    await expectCleanOff(p);
    await p.reload();
    await expect(p.locator('#enabled')).toBeEnabled();
    await p.waitForTimeout(300);
    await expectCleanOff(p);
    await p.close();
  }
});

test('A11 OFF中は通信断・内部ページでも未確認や復元の注記を出さない', async ({ lateExt: ext, site }) => {
  // 導入前から開いていたページ = content script が無く通信できない
  const video = await ext.open(site.url('single.html'));
  const internal = await ext.open('about:blank');
  await ext.install();
  await ext.save({ enabled: false, language: 'ja' });
  const internalId = await ext.tabId(internal);
  const videoId = await ext.tabId(video);
  await ext.triggerAction(video);
  for (const tabId of [videoId, internalId]) {
    const p = await ext.openPopup(tabId);
    await p.waitForTimeout(600);
    await expectCleanOff(p);
    await p.reload();
    await expect(p.locator('#enabled')).toBeEnabled();
    await p.waitForTimeout(300);
    await expectCleanOff(p);
    await p.close();
  }
});

test('A16 ネイティブの速度変更をヘッダー・バッジへ反映し、動画なし・OFFでは空', async ({ ext, site, ja }) => {
  const { page, tabId, popup } = await ext.setup(site.url('single.html'), 1);
  await page.evaluate(() => { document.getElementById('v1').playbackRate = 1.5; });
  await expect.poll(async () => (await ext.badge(tabId)).text).toBe('1.5×');
  await expect(popup.locator('#statusText')).toHaveText('ON · 1.50×');

  const none = await ext.setup(site.url('no-video.html'), 0);
  await expect.poll(async () => (await ext.badge(none.tabId)).text).toBe('');
  await expect(none.popup.locator('#statusText')).toHaveText('ON');

  await none.popup.locator('#enabled').click();
  await expect.poll(async () => (await ext.badge(tabId)).text).toBe('');
});

test('A17 代表動画の優先順位・長いバッジ値・title がタブ切替と複数フレームで一致', async ({ ext, site, ja }) => {
  const a = await ext.setup(site.url('two-videos.html'), 3, { popup: false });
  await a.page.evaluate(async () => {
    const [v1, v2] = T.videos();
    v1.playbackRate = 2;
    v2.playbackRate = 3.95;
    await v2.play();
  });
  await expect.poll(() => ext.badge(a.tabId)).toEqual({ text: '3.95', title: '動画再生速度変更 · ON · 3.95×' });

  // トップの動画を止め、iframe の動画を再生 → 再生中のフレームが代表
  await a.page.evaluate(() => T.videos()[1].pause());
  await frameByUrl(a.page, 'frame-video').evaluate(async () => {
    const v = T.videos()[0];
    v.playbackRate = 1.5;
    await v.play();
  });
  await expect.poll(() => ext.badge(a.tabId)).toEqual({ text: '1.5×', title: '動画再生速度変更 · ON · 1.5×' });

  // 再生中がなければ画面内 → トップフレーム
  await frameByUrl(a.page, 'frame-video').evaluate(() => T.videos()[0].pause());
  await expect.poll(async () => (await ext.badge(a.tabId)).text).toBe('2×');

  // 別タブは別のバッジ
  const b = await ext.setup(site.url('single.html'), 1, { popup: false });
  await b.page.evaluate(() => { document.getElementById('v1').playbackRate = 12.5; });
  await expect.poll(() => ext.badge(b.tabId)).toEqual({ text: '12.5', title: '動画再生速度変更 · ON · 12.5×' });
  await a.page.bringToFront();
  await expect.poll(async () => (await ext.badge(a.tabId)).text).toBe('2×');
  const popup = await ext.openPopup(a.tabId);
  await expect(popup.locator('#statusText')).toHaveText('ON · 2.00×');
});

test('A25 chrome://extensions / edge://extensions では再読み込み文もボタンも出さない', async ({ ext, ja }) => {
  const page = await ext.context.newPage();
  await page.goto(ext.channel === 'msedge' ? 'edge://extensions/' : 'chrome://extensions/');
  const tabId = await ext.tabId(page);
  await ext.triggerAction(page);
  const popup = await ext.openPopup(tabId);
  await popup.waitForTimeout(800);
  await expectNoNotice(popup);
  await expect(popup.locator('#statusText')).toHaveText('ON');
});

test('A26 URL取得不可で報告なしは案内なし。報告ありなら動画0・変更拒否を診断', async ({ lateExt: ext, site }) => {
  // URL 取得不可（ツールバー操作なし）＋報告なし（導入前から開いていたページ）
  const page = await ext.open(site.url('single.html'));
  await ext.install();
  await ext.save({ language: 'ja' });
  const tabId = await ext.tabId(page);
  const p1 = await ext.openPopup(tabId);
  await p1.waitForTimeout(900);
  await expectNoNotice(p1);

  // URL 取得不可でも実報告があれば診断する
  const none = await ext.setup(site.url('no-video.html'), 0);
  await expect(none.popup.locator('#noticeText')).toHaveText('動画が見つかりません。');
  await expect(none.popup.locator('#reloadButton')).toBeHidden();

  const reject = await ext.setup(site.url('reject.html'), 1);
  await preset(reject.popup, 4).click();
  await expect(reject.popup.locator('#noticeText')).toHaveText('再生速度を変更できません。');
  await expect(reject.popup.locator('#reloadButton')).toBeHidden();
  expect(await rates(reject.page)).toEqual([1]);
});

test('A27 通常HTTPで報告なしは再読込案内、接続済み動画0は動画なし、拒否は変更エラー', async ({ lateExt: ext, site }) => {
  const page = await ext.open(site.url('single.html'));
  await ext.install();
  await ext.save({ language: 'ja' });
  const tabId = await ext.tabId(page);
  await ext.triggerAction(page);
  const p1 = await ext.openPopup(tabId);
  await expect(p1.locator('#noticeText')).toHaveText('ページを再読み込みしてください。');
  await expect(p1.locator('#reloadButton')).toBeVisible();
  await expect(p1.locator('#reloadButton')).toHaveAttribute('aria-label', 'このタブを再読み込み');

  const none = await ext.open(site.url('no-video.html'));
  const noneId = await ext.tabId(none);
  await ext.triggerAction(none);
  const p2 = await ext.openPopup(noneId);
  await expect(p2.locator('#noticeText')).toHaveText('動画が見つかりません。');
  await expect(p2.locator('#reloadButton')).toBeHidden();

  const reject = await ext.open(site.url('reject.html'));
  const rejectId = await ext.tabId(reject);
  await ext.waitForVideos(rejectId, 1);
  await ext.triggerAction(reject);
  const p3 = await ext.openPopup(rejectId);
  await preset(p3, 8).click();
  await expect(p3.locator('#noticeText')).toHaveText('再生速度を変更できません。');
  await expect(p3.locator('#reloadButton')).toBeHidden();
});

test('A28 再読込は対象タブ1個だけ・連打は1回・失敗後に再試行できる', async ({ lateExt: ext, site }) => {
  const other = await ext.open(site.url('single.html?other'));
  const target = await ext.open(site.url('single.html?target'));
  await ext.install();
  await ext.save({ language: 'ja' });
  const targetId = await ext.tabId(target);
  await ext.triggerAction(target);
  const popup = await ext.openPopup(targetId);
  await expect(popup.locator('#reloadButton')).toBeVisible();

  // 失敗 → エラー表示 → 再試行できる
  await popup.evaluate(() => {
    window.__reload = chrome.tabs.reload;
    chrome.tabs.reload = () => Promise.reject(new Error('simulated'));
  });
  await popup.locator('#reloadButton').click();
  await expect(popup.locator('#noticeText')).toHaveText('再読み込みできませんでした。');
  await expect(popup.locator('#reloadButton')).toBeEnabled();
  await popup.evaluate(() => { chrome.tabs.reload = window.__reload; });

  let targetLoads = 0;
  let otherLoads = 0;
  target.on('load', () => { targetLoads += 1; });
  other.on('load', () => { otherLoads += 1; });
  await popup.locator('#reloadButton').click();
  await popup.locator('#reloadButton').click({ force: true, timeout: 1000 }).catch(() => {});
  await expect(popup.locator('#statusText')).toHaveText('ON · 1.00×', { timeout: 15000 });
  await expectNoNotice(popup);
  await popup.waitForTimeout(800);
  expect(targetLoads).toBe(1);
  expect(otherLoads).toBe(0);
});

test('A29 速度指示の応答が失われても再照会で成功を確認し、変更失敗にしない', async ({ ext, site, ja }) => {
  const { page, popup } = await ext.setup(site.url('two-videos.html'), 3);
  // 応答も、その指示への requestId 付きの報告も失われる（観測できるのは再照会の結果だけ）
  await ext.recordSentMessages({ dropResponseFor: 'TEMPO_SET_SPEED', dropTaggedReports: true });
  await preset(popup, 4).click();
  await expect.poll(() => rates(page)).toEqual([4, 4]);
  await expect(popup.locator('#statusText')).toHaveText('ON · 4.00×');
  await popup.waitForTimeout(300);
  await expectNoNotice(popup);
  const sent = await ext.sentMessages();
  expect(sent).toContain('TEMPO_SET_SPEED');
  expect(sent).toContain('TEMPO_REQUEST_REPORT');
  expect(sent.filter((m) => m === 'TEMPO_SET_SPEED')).toHaveLength(1);
});

test('A30 遅延iframe・iframe交換・遷移前報告・動画削除で古い結果を採用しない', async ({ ext, site, ja }) => {
  // 遅延 iframe: 最初の空応答のあとに動画が現れたら表示を回復する
  const page = await ext.open(site.url('delayed.html'));
  const tabId = await ext.tabId(page);
  const popup = await ext.openPopup(tabId, { waitState: false });
  await expect(popup.locator('#statusText')).toHaveText('ON · 1.00×', { timeout: 10000 });
  await expectNoNotice(popup);

  // iframe 交換: 古いフレームの動画を数えない
  await page.evaluate(() => mountFrame('frame-video.html'));
  await expect.poll(async () => (await ext.tabState(tabId)).videoCount, { timeout: 10000 }).toBe(1);
  await page.evaluate(() => mountFrame('frame-delayed.html'));
  await expect.poll(async () => (await ext.tabState(tabId)).videoCount, { timeout: 10000 }).toBe(1);

  // 遷移: 前のページの報告を残さない
  await page.goto(site.url('no-video.html'));
  await expect.poll(async () => (await ext.tabState(tabId)).videoCount).toBe(0);
  await expect.poll(async () => (await ext.badge(tabId)).text).toBe('');

  // 動画削除
  await page.goto(site.url('single.html'));
  await ext.waitForVideos(tabId, 1);
  await page.evaluate(() => addVideo());
  await ext.waitForVideos(tabId, 2);
  await page.evaluate(() => removeVideo('v2'));
  await ext.waitForVideos(tabId, 1);
});

test('A30 content script が動かないページへの遷移・戻るで前のページの倍率を残さない', async ({ ext, site, ja }) => {
  const { page, tabId } = await ext.setup(site.url('single.html'), 1, { popup: false });
  await page.evaluate(() => { document.getElementById('v1').playbackRate = 2; });
  await expect.poll(async () => (await ext.badge(tabId)).text).toBe('2×');
  await page.goto(ext.channel === 'msedge' ? 'edge://version/' : 'chrome://version/');
  await expect.poll(async () => (await ext.badge(tabId)).text, { timeout: 10000 }).toBe('');
  await page.goBack();
  await expect.poll(async () => (await ext.tabState(tabId)).videoCount, { timeout: 10000 }).toBe(1);
  await page.evaluate(() => { document.getElementById('v1').playbackRate = 3; });
  await expect.poll(async () => (await ext.badge(tabId)).text, { timeout: 10000 }).toBe('3×');
});

test('A33 親プレーヤーへ伝播しない・コンテナー全画面でパネル移動・video直接全画面で非表示', async ({ ext, site, ja }) => {
  const { page } = await ext.setup(site.url('player.html'), 1, { popup: false });
  const p = panel(page, 0);
  await expect(p.locator('.panel')).toBeVisible();
  await p.locator('.plus').click();
  await p.locator('.rate').dblclick();
  await p.locator('.toggle').click();
  await p.locator('.preset[data-speed="2"]').click();
  await p.locator('.plus').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await p.locator('.input').fill('3');
  await p.locator('.input').press('Enter');
  expect(await page.evaluate(() => window.counts)).toEqual({ player: 0, doc: 0, toggles: 0 });
  await expect.poll(() => rates(page)).toEqual([3]);
  await expect.poll(async () => (await ext.storage()).tempoSettings.speed).toBe(3);

  // ページのスクリプトからはパネルを操作できない（共通の保存速度を書き換えられない）
  await page.evaluate(() => {
    const root = document.querySelector('tempo-speed-panel').shadowRoot;
    root.querySelector('.preset[data-speed="16"]').click();
    root.querySelector('.plus').click();
    const input = root.querySelector('.input');
    input.value = '9';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  expect(await rates(page)).toEqual([3]);
  expect((await ext.storage()).tempoSettings.speed).toBe(3);

  await page.click('#fsBox');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement && document.fullscreenElement.id)).toBe('player');
  await expect.poll(() => page.evaluate(() => !!document.querySelector('#player > tempo-speed-panel'))).toBe(true);
  await expect(p.locator('.panel')).toBeVisible();
  const before = await page.evaluate(() => ({ ...window.counts }));
  await p.locator('.preset[data-speed="4"]').click();
  expect(await page.evaluate(() => window.counts)).toEqual(before);
  await expect.poll(() => rates(page)).toEqual([4]);
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await expect.poll(() => page.evaluate(() => !!document.querySelector('html > tempo-speed-panel'))).toBe(true);

  await page.click('#fsVideo');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement && document.fullscreenElement.id)).toBe('v1');
  await expect.poll(() => visiblePanels(page)).toBe(0);
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => visiblePanels(page)).toBe(1);

  // webkitRequestFullscreen でも全画面コンテナー内へ即座に移動する
  await page.evaluate(() => {
    const btn = document.createElement('button');
    btn.id = 'wkFsBox';
    btn.onclick = () => document.getElementById('player').webkitRequestFullscreen();
    document.body.appendChild(btn);
  });
  await page.click('#wkFsBox');
  await expect.poll(() => page.evaluate(() => !!document.querySelector('#player > tempo-speed-panel'))).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => !!document.querySelector('html > tempo-speed-panel'))).toBe(true);
});

test('A34 worker再起動から実状態を再構築・URLや視聴情報を保存/送信しない・削除時に購読を解放', async ({ ext, site, ja }) => {
  const requests = [];
  ext.context.on('request', (r) => requests.push(r.url()));
  const { page, tabId, popup } = await ext.setup(site.url('two-videos.html'), 3);
  await popup.locator('#speedInput').fill('3');
  await popup.locator('#speedInput').press('Enter');
  await expect.poll(() => rates(page)).toEqual([3, 3]);

  await ext.stopWorker(page);
  await page.waitForTimeout(500);
  // worker 再起動後に言語を変更しても既存タブのバッジ title が新しい言語へ更新される
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'TEMPO_SAVE_SETTINGS', patch: { language: 'en' } }));
  await expect.poll(async () => (await ext.badge(tabId)).title).toBe('Tempo – Video Playback Speed · ON · 3×');
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'TEMPO_SAVE_SETTINGS', patch: { language: 'ja' } }));
  await expect.poll(async () => (await ext.badge(tabId)).title).toBe('動画再生速度変更 · ON · 3×');

  await ext.stopWorker(page);
  await page.waitForTimeout(500);
  const state = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: 'TEMPO_GET_TAB_STATE', tabId: id }), tabId);
  expect(await ext.sw(() => self.__alive)).toBeUndefined();
  expect(state.connected).toBe(true);
  expect(state.videoCount).toBe(3);
  expect(state.speed).toBe(3);
  await page.evaluate(() => { T.videos()[0].playbackRate = 5; });
  await expect.poll(async () => (await ext.badge(tabId)).text).toMatch(/^(5×|3×)$/);

  // 削除した動画のイベントを受け取らない
  await page.evaluate(() => { window.removed = T.videos()[1]; window.removed.remove(); });
  await expect.poll(async () => (await ext.tabState(tabId)).videoCount).toBe(2);
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('tempo-speed-panel').length)).toBe(1);
  await page.evaluate(() => { window.removed.playbackRate = 7; });
  await page.waitForTimeout(300);
  const after = await ext.tabState(tabId);
  expect(after.videoCount).toBe(2);
  expect(after.frames.flatMap((f) => f.rates)).not.toContain(7);

  // 保存内容と通信先
  const stored = await ext.storage();
  expect(Object.keys(stored).sort()).toEqual(['tempoLanguage', 'tempoSettings']);
  expect(JSON.stringify(stored)).not.toMatch(/http|127\.0\.0\.1|localhost|video/);
  const external = requests.filter((u) => !u.startsWith(site.origin) && !u.startsWith(site.crossOrigin) &&
    !/^(chrome-extension|chrome|edge|about|data|blob):/.test(u));
  expect(external).toEqual([]);
});
