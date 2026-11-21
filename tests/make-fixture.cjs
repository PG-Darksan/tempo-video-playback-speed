/*
 * テスト用のローカル動画 (fixtures/media/bright.webm, dark.webm) を作る。
 * ffmpeg を使わず、Playwright の Chromium で canvas を MediaRecorder に録画する。
 *   npm run make:fixture
 */
'use strict';

const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'fixtures', 'media');
const SECONDS = 8;

const VARIANTS = {
  bright: { background: '#f4f1e8', accent: '#e8a33d', text: '#1d2a30' },
  dark: { background: '#11161a', accent: '#3fb8a5', text: '#e9f2f0' }
};

async function record(page, colors) {
  return page.evaluate(async ({ colors, seconds }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 600000 });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const started = performance.now();
    const draw = () => {
      const t = (performance.now() - started) / 1000;
      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = colors.accent;
      const x = 40 + ((t * 120) % 560);
      ctx.beginPath();
      ctx.arc(x, 180 + Math.sin(t * 3) * 90, 34, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = colors.text;
      ctx.font = 'bold 44px sans-serif';
      ctx.fillText(`${t.toFixed(1)} s`, 24, 330);
    };
    draw();
    const timer = setInterval(draw, 33);
    recorder.start(250);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    clearInterval(timer);
    recorder.stop();
    await new Promise((r) => (recorder.onstop = r));
    const blob = new Blob(chunks, { type: 'video/webm' });
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
    return btoa(binary);
  }, { colors, seconds: SECONDS });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    await Promise.all(Object.entries(VARIANTS).map(async ([name, colors]) => {
      const page = await browser.newPage();
      await page.setContent('<!doctype html><body style="margin:0">');
      const data = await record(page, colors);
      const file = path.join(OUT_DIR, `${name}.webm`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`作成: ${path.relative(__dirname, file)} (${fs.statSync(file).size} bytes)`);
    }));
  } finally {
    await browser.close();
  }
})();
