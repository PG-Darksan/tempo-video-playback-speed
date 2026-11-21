/*
 * 動画再生速度変更 — 共通定数と設定の検証
 * popup / service worker / content script の全コンテキストから読み込む。
 */
(function (root) {
  'use strict';

  if (root.TempoShared) return;

  const MIN_SPEED = 0.25;
  const MAX_SPEED = 16;
  const SLIDER_STEP = 0.05;
  const STEP = 0.25;
  const PRESETS = Object.freeze([1, 2, 4, 8, 16]);
  const EPSILON = 0.001;
  const SETTINGS_VERSION = 1;

  const KEYS = Object.freeze({
    settings: 'tempoSettings',
    language: 'tempoLanguage'
  });

  const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,
    enabled: true,
    speed: 1,
    showOverlay: true,
    rememberSpeed: true
  });

  const BOOLEAN_KEYS = Object.freeze(['enabled', 'showOverlay', 'rememberSpeed']);

  const MSG = Object.freeze({
    saveSettings: 'TEMPO_SAVE_SETTINGS',
    getTabState: 'TEMPO_GET_TAB_STATE',
    setTabSpeed: 'TEMPO_SET_TAB_SPEED',
    setSpeed: 'TEMPO_SET_SPEED',
    requestReport: 'TEMPO_REQUEST_REPORT',
    reportState: 'TEMPO_REPORT_STATE',
    getState: 'TEMPO_GET_STATE',
    tabStateChanged: 'TEMPO_TAB_STATE_CHANGED'
  });

  const AUTHOR_URL = 'https://hisator-notebook.com';

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  function clampSpeed(value) {
    return Math.min(MAX_SPEED, Math.max(MIN_SPEED, value));
  }

  /** 保存値として受け付ける速度。有限数でなければ null。 */
  function normalizeSpeed(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return round2(clampSpeed(value));
  }

  function sanitizeSettings(raw) {
    const out = { ...DEFAULT_SETTINGS };
    if (!raw || typeof raw !== 'object') return out;
    for (const key of BOOLEAN_KEYS) {
      if (typeof raw[key] === 'boolean') out[key] = raw[key];
    }
    const speed = normalizeSpeed(raw.speed);
    out.speed = speed == null ? DEFAULT_SETTINGS.speed : speed;
    out.version = SETTINGS_VERSION;
    return out;
  }

  /**
   * 利用者の入力文字列を速度へ変換する。
   * 空欄・非数値・範囲外は null（適用も保存もしない）。全角数字と小数点「，」も受け付ける。
   */
  function parseSpeedInput(text) {
    if (typeof text !== 'string') return null;
    const ascii = text
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[．，,]/g, '.')
      .trim()
      .replace(/\s*[×xXｘＸ倍]$/, '');
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(ascii)) return null;
    const value = Number(ascii);
    if (!Number.isFinite(value) || value < MIN_SPEED || value > MAX_SPEED) return null;
    return round2(value);
  }

  /** ポップアップ用: 常に小数2桁。 */
  function formatFixed(value) {
    return round2(value).toFixed(2);
  }

  /** 動画上パネル・バッジ用: 末尾の不要な0を省略。 */
  function formatShort(value) {
    return String(round2(value));
  }

  /** バッジ文字列: 単位付きで4文字以下ならそのまま、長ければ数値のみ。 */
  function badgeText(value) {
    const withUnit = formatShort(value) + '×';
    return withUnit.length <= 4 ? withUnit : formatShort(value);
  }

  function sameSpeed(a, b) {
    return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < EPSILON;
  }

  /** 拡張機能を動かせない（ブラウザーが content script を止める）ストアのページ。 */
  const STORE_PAGES = [
    /^https:\/\/chromewebstore\.google\.com\//i,
    /^https:\/\/chrome\.google\.com\/webstore/i,
    /^https:\/\/microsoftedge\.microsoft\.com\/addons/i
  ];

  /** ポップアップの再読み込み可否に使う URL 分類。URL は保存しない。 */
  function classifyUrl(url) {
    if (typeof url !== 'string' || url === '') return 'unknown';
    if (STORE_PAGES.some((pattern) => pattern.test(url))) return 'internal';
    if (/^(https?|file):/i.test(url)) return 'web';
    return 'internal';
  }

  root.TempoShared = Object.freeze({
    MIN_SPEED,
    MAX_SPEED,
    SLIDER_STEP,
    STEP,
    PRESETS,
    EPSILON,
    SETTINGS_VERSION,
    KEYS,
    DEFAULT_SETTINGS,
    BOOLEAN_KEYS,
    MSG,
    AUTHOR_URL,
    round2,
    clampSpeed,
    normalizeSpeed,
    sanitizeSettings,
    parseSpeedInput,
    formatFixed,
    formatShort,
    badgeText,
    sameSpeed,
    classifyUrl
  });
})(globalThis);
