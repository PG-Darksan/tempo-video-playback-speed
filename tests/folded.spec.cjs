// 受入項目 A18〜A21（動画上パネルの折りたたみと淡い復帰アイコン）
'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect, rates, frameByUrl, frameRates, visiblePanels, panel } = require('./helpers.cjs');

const SCREENS = path.join(__dirname, 'results', 'screens');

function activeClass(target, index = 0) {
  return target.evaluate((i) => {
    const host = document.querySelectorAll('tempo-speed-panel')[i];
    const active = host && host.shadowRoot.activeElement;
    return active ? active.className : null;
  }, index);
}

/** 折りたたみ時の外観を計測する。 */
function measureFolded(target, index = 0) {
  return target.evaluate((i) => {
    const root = document.querySelectorAll('tempo-speed-panel')[i].shadowRoot;
    const box = root.querySelector('.panel');
    const button = root.querySelector('.restore');
    const icon = button.querySelector('svg');
    const pr = box.getBoundingClientRect();
    const br = button.getBoundingClientRect();
    const ir = icon.getBoundingClientRect();
    const ps = getComputedStyle(box);
    const bs = getComputedStyle(button);
    return {
      panel: [pr.width, pr.height],
      button: [br.width, br.height],
      icon: [ir.width, ir.height],
      background: ps.backgroundColor,
      border: ps.borderTopColor,
      borderWidth: ps.borderTopWidth,
      radius: ps.borderTopLeftRadius,
      shadow: ps.boxShadow,
      line: bs.color,
      outline: `${bs.outlineWidth} ${bs.outlineStyle} ${bs.outlineColor}`,
      text: box.innerText.trim(),
      shapes: [...icon.children].map((c) => c.tagName.toLowerCase()),
      fill: icon.getAttribute('fill'),
      paths: [...icon.querySelectorAll('path')].map((p) => p.getAttribute('d'))
    };
  }, index);
}

async function shot(target, name, testInfo, clip) {
  fs.mkdirSync(SCREENS, { recursive: true });
  const file = path.join(SCREENS, `${testInfo.project.name}-${name}.png`);
  await target.screenshot({ path: file, clip });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

const FAINT = { background: 'rgba(18, 31, 35, 0.24)', border: 'rgba(255, 255, 255, 0.1)', line: 'rgba(255, 255, 255, 0.65)' };
const STRONG = { background: 'rgba(18, 31, 35, 0.68)', border: 'rgba(255, 255, 255, 0.18)', line: 'rgb(244, 250, 249)' };

test('A18 詳細開・2.55倍で Enter 折りたたみ → Space 復帰。速度・詳細開・フォーカスを維持', async ({ ext, site, ja }, testInfo) => {
  const { page } = await ext.setup(site.url('single.html'), 1, { popup: false });
  const p = panel(page);
  await expect(p.locator('.panel')).toBeVisible();
  const basic = await p.locator('.panel').boundingBox();
  await shot(page, 'A18-basic', testInfo, { x: basic.x - 20, y: basic.y - 20, width: basic.width + 40, height: basic.height + 40 });
  await p.locator('.toggle').click();
  await expect(p.locator('.toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(p.locator('.toggle')).toHaveAttribute('aria-controls', 'tempo-details');
  await p.locator('.input').fill('2.55');
  await p.locator('.input').press('Enter');
  await expect.poll(() => rates(page)).toEqual([2.55]);
  await page.mouse.move(1270, 790);
  const details = await p.locator('.panel').boundingBox();
  await shot(page, 'A18-details', testInfo, { x: details.x - 20, y: details.y - 20, width: details.width + 40, height: details.height + 40 });

  await p.locator('.fold').focus();
  await page.keyboard.press('Enter');
  await expect(p.locator('.restore')).toBeVisible();
  await expect(p.locator('.body')).toBeHidden();
  expect(await activeClass(page)).toBe('restore');
  await expect(p.locator('.restore')).toHaveAttribute('aria-expanded', 'false');
  await expect(p.locator('.restore')).toHaveAttribute('aria-controls', 'tempo-body');
  await expect(p.locator('.restore')).toHaveAttribute('aria-label', 'コントローラーを開く');
  await expect(p.locator('.restore')).toHaveAttribute('title', 'コントローラーを開く · 2.55×');

  await page.keyboard.press('Space');
  await expect(p.locator('.body')).toBeVisible();
  await expect(p.locator('.details')).toBeVisible();
  await expect(p.locator('.rate')).toHaveText('2.55×');
  await expect(p.locator('.fold')).toHaveAttribute('aria-expanded', 'true');
  expect(await activeClass(page)).toContain('fold');
  expect(await rates(page)).toEqual([2.55]);
});

test('A19 復帰アイコンは外寸28×28・線画12px・通常24%背景・影なし、ロゴ/倍率を表示しない（明るい・暗い動画）', async ({ ext, site, ja }, testInfo) => {
  const { page } = await ext.setup(site.url('two-videos.html'), 3, { popup: false });
  for (const index of [0, 1]) {
    await panel(page, index).locator('.fold').click();
  }
  await page.mouse.move(1270, 790);
  await page.waitForTimeout(250);
  for (const [index, name] of [[0, 'bright'], [1, 'dark']]) {
    const m = await measureFolded(page, index);
    expect(m.panel).toEqual([28, 28]);
    expect(m.button).toEqual([26, 26]);
    expect(m.icon).toEqual([12, 12]);
    expect(m.borderWidth).toBe('1px');
    expect(m.radius).toBe('7px');
    expect(m.shadow).toBe('none');
    expect(m.background).toBe(FAINT.background);
    expect(m.border).toBe(FAINT.border);
    expect(m.line).toBe(FAINT.line);
    expect(m.text).toBe('');
    expect(m.fill).toBe('none');
    expect(m.shapes).toEqual(['path', 'circle', 'circle']);
    expect(m.paths).toEqual(['M2 5h3m3 0h6M2 11h6m3 0h3']);
    const box = await panel(page, index).locator('.panel').boundingBox();
    await shot(page, `A19-folded-${name}`, testInfo, { x: box.x - 30, y: box.y - 30, width: 140, height: 100 });
  }
});

test('A20 マウス離脱で淡い状態に戻り、キーボード focus-visible では背景を強め2pxの輪郭', async ({ ext, site, ja }, testInfo) => {
  const { page } = await ext.setup(site.url('single.html'), 1, { popup: false });
  const p = panel(page);
  await p.locator('.fold').click();
  await page.mouse.move(1270, 790);
  await page.waitForTimeout(250);
  expect(await measureFolded(page)).toMatchObject(FAINT);

  await p.locator('.restore').hover();
  await page.waitForTimeout(250);
  expect(await measureFolded(page)).toMatchObject(STRONG);
  const box = await p.locator('.panel').boundingBox();
  await shot(page, 'A20-hover', testInfo, { x: box.x - 30, y: box.y - 30, width: 140, height: 100 });

  await page.mouse.move(1270, 790);
  await page.waitForTimeout(250);
  expect(await measureFolded(page)).toMatchObject(FAINT);

  // ポインターで開閉した後は強い状態を残さない
  await p.locator('.restore').click();
  await p.locator('.fold').click();
  await page.mouse.move(1270, 790);
  await page.waitForTimeout(250);
  const afterPointer = await measureFolded(page);
  expect(afterPointer).toMatchObject(FAINT);
  expect(afterPointer.outline).not.toContain('2px solid');

  // キーボード: Tab で復帰ボタンへ
  await page.mouse.click(1270, 790);
  await page.keyboard.press('Tab');
  expect(await activeClass(page)).toBe('restore');
  await page.waitForTimeout(250);
  const keyboard = await measureFolded(page);
  expect(keyboard).toMatchObject(STRONG);
  expect(keyboard.outline).toBe('2px solid rgb(117, 224, 206)');
  await shot(page, 'A20-focus-visible', testInfo, { x: box.x - 30, y: box.y - 30, width: 140, height: 100 });
});

test('A21 複数動画・iframe の折りたたみは独立。185×88未満・画面外は非表示でもポップアップで操作できる', async ({ ext, site, ja }) => {
  const a = await ext.setup(site.url('two-videos.html'), 3, { popup: false });
  const frame = frameByUrl(a.page, 'frame-video');
  await panel(a.page, 0).locator('.fold').click();
  await expect(panel(a.page, 0).locator('.restore')).toBeVisible();
  await expect(panel(a.page, 1).locator('.body')).toBeVisible();
  await expect(panel(frame, 0).locator('.body')).toBeVisible();
  await panel(frame, 0).locator('.fold').click();
  await expect(panel(frame, 0).locator('.restore')).toBeVisible();
  await expect(panel(a.page, 1).locator('.body')).toBeVisible();
  await expect(panel(a.page, 0).locator('.restore')).toBeVisible();
  await panel(a.page, 1).locator('.plus').click();
  await expect.poll(() => rates(a.page)).toEqual([1, 1.25]);
  expect(await frameRates(a.page, 'frame-video')).toEqual([1]);

  const b = await ext.setup(site.url('sizes.html'), 3);
  await b.page.bringToFront();
  await expect.poll(() => visiblePanels(b.page)).toBe(1);
  await b.popup.bringToFront();
  await b.popup.locator('.preset[data-speed="2"]').click();
  await expect.poll(() => rates(b.page)).toEqual([2, 2, 2]);
  await b.page.bringToFront();
  await b.page.evaluate(() => document.getElementById('far').scrollIntoView());
  await expect.poll(() => visiblePanels(b.page)).toBe(1);
  // 画面外だった動画のパネル（2つ目に作られる）が現れる
  await expect(panel(b.page, 1).locator('.panel')).toBeVisible();
  await expect(panel(b.page, 1).locator('.rate')).toHaveText('2×');
});
