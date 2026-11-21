/*
 * 動画再生速度変更 — Service Worker
 *  - 設定保存の直列化（保存直前に再読込して許可項目だけをマージ）
 *  - 各フレームの実報告の集約（requestId と観測時刻で新旧を判定）
 *  - タブ別バッジとツールチップ
 * タブの状態はメモリーだけに持ち、URL や視聴情報は保存しない。
 */
'use strict';

importScripts('shared.js', 'i18n.js');

const S = self.TempoShared;
const I = self.TempoI18n;
const { MSG, KEYS } = S;

const COLLECT_DEADLINE_MS = 400;
const COLLECT_QUIET_MS = 60;
const COLLECT_EXTENDED_MS = 1100;
const NOTIFY_DELAY_MS = 25;
const RETRY_DELAY_MS = 150;
const DELIVERY_GRACE_MS = 1200;
const REFRESH_DELAY_MS = 250;
const MAX_RATES = 500;
const EXTENSION_ORIGIN = chrome.runtime.getURL('');

// ---------------------------------------------------------------------------
// 設定のメモリー写し（バッジとツールチップ用）
// ---------------------------------------------------------------------------

let settingsCache = { ...S.DEFAULT_SETTINGS };
let languageCache = 'auto';
let settingsVersion = 0;
let languageVersion = 0;
let settingsLoaded = false;

// 初期読込より先に変更を購読し、古い読込で新しい値を上書きしない。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let refresh = false;
  if (changes[KEYS.settings]) {
    settingsVersion += 1;
    const prev = settingsCache;
    settingsCache = S.sanitizeSettings(changes[KEYS.settings].newValue);
    refresh = refresh || !settingsLoaded || prev.enabled !== settingsCache.enabled;
  }
  if (changes[KEYS.language]) {
    languageVersion += 1;
    languageCache = I.sanitizePreference(changes[KEYS.language].newValue);
    refresh = true;
  }
  if (refresh) refreshAllBadges();
});

const settingsReady = (async () => {
  const sv = settingsVersion;
  const lv = languageVersion;
  try {
    const stored = await chrome.storage.local.get([KEYS.settings, KEYS.language]);
    if (sv === settingsVersion) settingsCache = S.sanitizeSettings(stored[KEYS.settings]);
    if (lv === languageVersion) languageCache = I.sanitizePreference(stored[KEYS.language]);
  } catch (_) {
    // 読めなければ初期値のまま
  } finally {
    settingsLoaded = true;
  }
})();

// ---------------------------------------------------------------------------
// 設定保存の単一キュー
// ---------------------------------------------------------------------------

let saveQueue = Promise.resolve();

function enqueueSave(patch) {
  const job = saveQueue.then(() => applyPatch(patch));
  saveQueue = job.catch(() => {});
  return job;
}

async function applyPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('invalid patch');
  const stored = await chrome.storage.local.get([KEYS.settings, KEYS.language]);
  const settings = S.sanitizeSettings(stored[KEYS.settings]);
  let language = I.sanitizePreference(stored[KEYS.language]);
  const write = {};
  let touched = false;

  for (const key of S.BOOLEAN_KEYS) {
    if (!(key in patch)) continue;
    if (typeof patch[key] !== 'boolean') throw new Error('invalid ' + key);
    settings[key] = patch[key];
    touched = true;
  }
  if ('speed' in patch) {
    const speed = S.normalizeSpeed(patch.speed);
    if (speed == null) throw new Error('invalid speed');
    settings.speed = speed;
    touched = true;
  }
  if ('language' in patch) {
    if (patch.language !== 'auto' && !I.CODES.includes(patch.language)) throw new Error('invalid language');
    language = patch.language;
    write[KEYS.language] = language;
  }

  // 未保存・旧形式の設定は正規化して書き戻す（移行処理を兼ねる）。
  const raw = stored[KEYS.settings];
  const needsMigration = !raw || typeof raw !== 'object' || raw.version !== S.SETTINGS_VERSION;
  if (touched || needsMigration) write[KEYS.settings] = settings;
  if (!(KEYS.language in stored) && !(KEYS.language in write)) write[KEYS.language] = language;

  if (Object.keys(write).length) await chrome.storage.local.set(write);
  return { settings, language };
}

chrome.runtime.onInstalled.addListener(() => {
  enqueueSave({}).catch(() => {});
});

// ---------------------------------------------------------------------------
// フレーム報告
// ---------------------------------------------------------------------------

/** tabId -> { frames: Map<frameId, Frame> } */
const tabCache = new Map();
/** 収集中の照会 */
const pendingCollects = new Set();

let requestSeq = 0;
let lastUpdatedAt = 0;

function nextUpdatedAt() {
  lastUpdatedAt = Math.max(lastUpdatedAt + 1, Date.now());
  return lastUpdatedAt;
}

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function frameFromReport(report, frameId, documentId) {
  if (!report || typeof report !== 'object') return null;
  const rates = Array.isArray(report.rates)
    ? report.rates.filter((r) => typeof r === 'number' && Number.isFinite(r)).slice(0, MAX_RATES)
    : [];
  return {
    frameId: Number.isInteger(frameId) ? frameId : 0,
    documentId: typeof documentId === 'string' ? documentId : null,
    videoCount: rates.length,
    speed: rates.length ? finiteOr(report.speed, null) : null,
    rates,
    playing: report.playing === true,
    visible: report.visible === true,
    gone: report.gone === true,
    startedAt: finiteOr(report.startedAt, 0),
    observedAt: finiteOr(report.observedAt, Date.now())
  };
}

/**
 * next が prev より新しい（採用してよい）報告か。
 * 送信元が「今の文書（active）」であることは handleReport で確認済みなので、
 * 文書が替わった報告は到着順に採用する（戻る／進むで復元した古い文書も含む）。
 * documentId が無い報告（個別の生存確認の応答）だけ startedAt で比べる。
 */
function isNewer(prev, next) {
  if (!prev) return true;
  if (prev.documentId && next.documentId) {
    return prev.documentId === next.documentId ? next.observedAt >= prev.observedAt : true;
  }
  if (next.startedAt !== prev.startedAt) return next.startedAt > prev.startedAt;
  return next.observedAt >= prev.observedAt;
}

function sameDocument(a, b) {
  if (a.documentId && b.documentId) return a.documentId === b.documentId;
  return a.startedAt === b.startedAt;
}

/**
 * 報告を frames へ入れる。消えた文書は取り除く。
 * トップフレームの文書が替わった・消えたときは、古いページのサブフレームを捨て、
 * topChanged を返す（呼び出し側が実フレームへ照会し直す）。
 */
function mergeFrame(frames, frame) {
  const prev = frames.get(frame.frameId);
  if (!isNewer(prev, frame)) return { accepted: false, topChanged: false };
  const top = frames.get(0);
  if (frame.frameId !== 0 && top && (!frame.documentId || !top.documentId) && frame.startedAt < top.startedAt) {
    return { accepted: false, topChanged: false };
  }
  if (frame.gone) {
    frames.delete(frame.frameId);
    if (frame.frameId !== 0) return { accepted: true, topChanged: false };
    frames.clear();
    return { accepted: true, topChanged: true };
  }
  frames.set(frame.frameId, frame);
  const topChanged = frame.frameId === 0 && !!prev && !sameDocument(prev, frame);
  if (topChanged) {
    for (const id of [...frames.keys()]) if (id !== 0) frames.delete(id);
  }
  return { accepted: true, topChanged };
}

/** 去った文書（active でない送信元）の消滅報告: その文書の記録だけを消す。 */
function forgetDocument(tabId, frameId, documentId) {
  const entry = tabCache.get(tabId);
  if (!entry) return;
  const cached = entry.frames.get(frameId);
  if (!cached || cached.documentId !== documentId) return;
  if (frameId === 0) entry.frames.clear();
  else entry.frames.delete(frameId);
  for (const pending of pendingCollects) {
    const p = pending.reports.get(frameId);
    if (pending.tabId === tabId && p && p.documentId === documentId) pending.reports.delete(frameId);
  }
  scheduleNotify(tabId);
  if (frameId === 0) scheduleRefresh(tabId);
}

function cacheFor(tabId) {
  let entry = tabCache.get(tabId);
  if (!entry) {
    entry = { frames: new Map() };
    tabCache.set(tabId, entry);
  }
  return entry;
}

function handleReport(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (!Number.isInteger(tabId)) return;
  if (sender.documentLifecycle && sender.documentLifecycle !== 'active') {
    // 事前レンダリング中・bfcache・削除待ちの文書。消滅報告だけを受け取る
    if (msg.report && msg.report.gone === true && typeof sender.documentId === 'string') {
      forgetDocument(tabId, sender.frameId, sender.documentId);
    }
    return;
  }
  const frame = frameFromReport(msg.report, sender.frameId, sender.documentId);
  if (!frame) return;

  for (const pending of pendingCollects) {
    if (pending.tabId !== tabId) continue;
    // 照会前に観測された無関係の報告は使わない
    if (msg.requestId !== pending.requestId && frame.observedAt < pending.startedAt) continue;
    if (msg.requestId === pending.requestId) {
      pending.answered = true;
      pending.answeredFrames.add(frame.frameId);
    }
    if (mergeFrame(pending.reports, frame).accepted) pending.check();
  }

  const result = mergeFrame(cacheFor(tabId).frames, frame);
  if (result.accepted) scheduleNotify(tabId);
  // ページが替わった（遷移・戻る／進む・事前レンダリングの表示）: 実フレームから作り直す
  if (result.topChanged) scheduleRefresh(tabId);
}

// ---------------------------------------------------------------------------
// 収集
// ---------------------------------------------------------------------------

/**
 * タブの全フレームへ type を送り、上り報告を集める。
 * 1つ目の応答だけで結論を出さず、締切 400ms。動画の報告と既知の動画フレームが揃えば
 * 60ms の静穏期間で早期終了する。
 */
function collect(tabId, type, extra) {
  return new Promise((resolve) => {
    requestSeq += 1;
    const pending = {
      tabId,
      requestId: `${Date.now().toString(36)}-${requestSeq}`,
      startedAt: Date.now(),
      reports: new Map(),
      delivered: null,
      answered: false,
      answeredFrames: new Set(),
      extended: false,
      done: false,
      quietTimer: 0,
      deadlineTimer: 0,
      check: () => {}
    };
    const cached = tabCache.get(tabId);
    const knownVideoFrames = cached
      ? [...cached.frames.values()].filter((f) => f.videoCount > 0).map((f) => f.frameId)
      : [];

    const finish = () => {
      if (pending.done) return;
      pending.done = true;
      clearTimeout(pending.quietTimer);
      clearTimeout(pending.deadlineTimer);
      pendingCollects.delete(pending);
      // delivered: true（届いた）/ false（届かなかった）/ null（締切までに分からない）。
      // この requestId への報告が来ていれば、応答が遅れていても指示は届いている。
      resolve({
        delivered: pending.answered ? true : pending.delivered,
        reports: pending.reports,
        delivery
      });
    };

    pending.check = () => {
      if (pending.done) return;
      if (pending.delivered === false && pending.reports.size === 0) {
        finish();
        return;
      }
      // 締切を延長した後は、この requestId への報告が届き、既知の動画フレームも揃えば静穏期間で終える
      if (pending.extended && pending.answeredFrames.size > 0 &&
          knownVideoFrames.every((id) => pending.reports.has(id))) {
        clearTimeout(pending.quietTimer);
        pending.quietTimer = setTimeout(finish, COLLECT_QUIET_MS);
        return;
      }
      // 早期終了は、送信の成否が分かり、動画のあるフレームがすべてこの requestId に答え、
      // 既知の動画フレームも揃ってから（無関係の上り報告だけで結論を出さない）
      if (pending.delivered === null) return;
      const reports = [...pending.reports.values()];
      const videoFrames = reports.filter((f) => f.videoCount > 0);
      const allAnswered = videoFrames.every((f) => pending.answeredFrames.has(f.frameId));
      const allKnown = knownVideoFrames.every((id) => pending.reports.has(id));
      if (videoFrames.length && allAnswered && allKnown) {
        clearTimeout(pending.quietTimer);
        pending.quietTimer = setTimeout(finish, COLLECT_QUIET_MS);
      }
    };

    pendingCollects.add(pending);
    pending.deadlineTimer = setTimeout(() => {
      // 混雑したページ: 指示が届いた（または未確定）のに報告がまだ無ければ、一度だけ締切を延ばす
      if (pending.delivered !== false && pending.answeredFrames.size === 0) {
        pending.extended = true;
        pending.deadlineTimer = setTimeout(finish, COLLECT_EXTENDED_MS);
        return;
      }
      finish();
    }, COLLECT_DEADLINE_MS);

    const delivery = chrome.tabs.sendMessage(tabId, { type, requestId: pending.requestId, ...(extra || {}) }).then(
      () => true,
      () => false
    );
    delivery.then((ok) => {
      pending.delivered = ok;
      pending.check();
    });
  });
}

function mergeAll(base, extra) {
  const out = new Map(base);
  for (const frame of extra.values()) mergeFrame(out, frame);
  return out;
}

function replaceCache(tabId, frames) {
  const entry = cacheFor(tabId);
  entry.frames = new Map(frames);
}

function countApplied(frames, target) {
  let applied = 0;
  for (const frame of frames.values()) {
    for (const rate of frame.rates) if (S.sameSpeed(rate, target)) applied += 1;
  }
  return applied;
}

/** フレーム間の代表: 再生中 → 画面内 → トップフレーム。 */
function pickFrame(frames) {
  const candidates = [...frames.values()].filter((f) => f.videoCount > 0 && f.speed != null);
  candidates.sort((a, b) =>
    (b.playing - a.playing) ||
    (b.visible - a.visible) ||
    ((a.frameId === 0 ? 0 : 1) - (b.frameId === 0 ? 0 : 1)) ||
    (a.frameId - b.frameId)
  );
  return candidates[0] || null;
}

function aggregate(frames) {
  const list = [...frames.values()];
  const rep = pickFrame(frames);
  return {
    ok: true,
    connected: list.length > 0,
    enabled: settingsCache.enabled,
    videoCount: list.reduce((sum, f) => sum + f.videoCount, 0),
    speed: rep ? rep.speed : null,
    frames: list.map((f) => ({
      frameId: f.frameId,
      videoCount: f.videoCount,
      speed: f.speed,
      rates: f.rates.slice(),
      playing: f.playing,
      visible: f.visible,
      startedAt: f.startedAt,
      observedAt: f.observedAt
    })),
    updatedAt: nextUpdatedAt()
  };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getTabState(tabId) {
  if (!Number.isInteger(tabId)) return { ok: false, error: 'no-tab' };
  await settingsReady;
  let result = await collect(tabId, MSG.requestReport);
  if (!result.delivered && result.reports.size === 0) {
    // 遷移中かもしれないので状態照会だけ1回再試行
    await delay(RETRY_DELAY_MS);
    result = await collect(tabId, MSG.requestReport);
  }
  replaceCache(tabId, result.reports);
  const state = aggregate(result.reports);
  applyBadge(tabId, state);
  return state;
}

const tabSpeedSeq = new Map();

async function setTabSpeed(tabId, speed) {
  if (!Number.isInteger(tabId)) return { ok: false, error: 'no-tab' };
  const target = S.normalizeSpeed(speed);
  if (target == null) return { ok: false, error: 'invalid-speed' };
  const seq = (tabSpeedSeq.get(tabId) || 0) + 1;
  tabSpeedSeq.set(tabId, seq);
  await settingsReady;
  if (tabSpeedSeq.get(tabId) !== seq) return { ok: false, error: 'superseded' };

  const first = await collect(tabId, MSG.setSpeed, { speed: target });
  if (tabSpeedSeq.get(tabId) !== seq) return { ok: false, error: 'superseded' };
  let delivered = first.delivered;
  if (delivered === null) {
    // 混雑したページでは受け取りが締切より遅れる。成否が分かるまで少し待つ
    delivered = await Promise.race([first.delivery, delay(DELIVERY_GRACE_MS).then(() => null)]);
    if (tabSpeedSeq.get(tabId) !== seq) return { ok: false, error: 'superseded' };
  }
  let frames = first.reports;
  let applied = countApplied(frames, target);
  let requeried = false;
  if (delivered !== true || applied === 0) {
    // 応答だけが失われた成功を失敗と決めつけない。速度指示は再送しない。
    requeried = true;
    const second = await collect(tabId, MSG.requestReport);
    if (tabSpeedSeq.get(tabId) !== seq) return { ok: false, error: 'superseded' };
    frames = mergeAll(frames, second.reports);
    applied = countApplied(frames, target);
  }
  replaceCache(tabId, frames);
  const state = aggregate(frames);
  applyBadge(tabId, state);
  return {
    ok: true,
    state,
    target,
    applied,
    failed: Math.max(0, state.videoCount - applied),
    delivered: delivered === true,
    requeried
  };
}

/** 生存確認: キャッシュ中のフレームへ個別に問い合わせ、応答しないものを捨てる。 */
async function refreshTab(tabId) {
  await settingsReady;
  const entry = tabCache.get(tabId);
  if (!entry || entry.frames.size === 0) {
    const result = await collect(tabId, MSG.requestReport);
    replaceCache(tabId, result.reports);
    applyBadge(tabId, aggregate(result.reports));
    return;
  }
  const checks = [...entry.frames.values()].map(async (prev) => {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: MSG.getState }, { frameId: prev.frameId });
      if (res && res.ok && res.report) {
        const frame = frameFromReport(res.report, prev.frameId, null);
        if (frame && frame.startedAt === prev.startedAt) frame.documentId = prev.documentId;
        return frame;
      }
    } catch (_) {
      // 応答なし = そのフレームは消えた
    }
    return { frameId: prev.frameId, gone: true };
  });
  const results = await Promise.all(checks);
  const current = tabCache.get(tabId);
  if (!current) return;
  for (const frame of results) {
    if (!frame) continue;
    // 個別の問い合わせへの直接の応答は、そのフレームの今の文書の状態
    if (frame.gone) current.frames.delete(frame.frameId);
    else current.frames.set(frame.frameId, frame);
  }
  applyBadge(tabId, aggregate(current.frames));
}

const refreshTimers = new Map();

/** 実フレームへ照会し直してキャッシュ・バッジ・ポップアップを更新する（まとめて1回）。 */
function scheduleRefresh(tabId) {
  clearTimeout(refreshTimers.get(tabId));
  refreshTimers.set(
    tabId,
    setTimeout(async () => {
      refreshTimers.delete(tabId);
      await settingsReady;
      const result = await collect(tabId, MSG.requestReport);
      replaceCache(tabId, result.reports);
      const state = aggregate(result.reports);
      applyBadge(tabId, state);
      notifyPopup(tabId, state);
    }, REFRESH_DELAY_MS)
  );
}

// ---------------------------------------------------------------------------
// バッジと通知
// ---------------------------------------------------------------------------

const lastBadge = new Map();
const notifyTimers = new Map();

chrome.action.setBadgeBackgroundColor({ color: '#087f75' }).catch(() => {});
if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => {});

function applyBadge(tabId, state) {
  const lang = I.resolve(languageCache);
  const name = I.t(lang, 'extName');
  let text = '';
  let title;
  if (!settingsCache.enabled) {
    title = `${name} · ${I.t(lang, 'statusOff')}`;
  } else if (state.videoCount > 0 && state.speed != null) {
    text = S.badgeText(state.speed);
    title = `${name} · ${I.t(lang, 'statusOn')} · ${S.formatShort(state.speed)}×`;
  } else {
    title = `${name} · ${I.t(lang, 'statusOn')}`;
  }
  const prev = lastBadge.get(tabId);
  if (prev && prev.text === text && prev.title === title) return;
  lastBadge.set(tabId, { text, title });
  chrome.action.setBadgeText({ tabId, text }).catch(() => lastBadge.delete(tabId));
  chrome.action.setTitle({ tabId, title }).catch(() => lastBadge.delete(tabId));
}

async function refreshAllBadges() {
  await settingsReady;
  for (const [tabId, entry] of tabCache) {
    applyBadge(tabId, aggregate(entry.frames));
  }
  // Service Worker 再起動後や凍結タブでも、全タブのバッジとツールチップを最新の設定・言語へ揃える
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (_) {
    return;
  }
  const empty = { videoCount: 0, speed: null };
  for (const tab of tabs) {
    if (!tab || !Number.isInteger(tab.id) || tab.id < 0 || tabCache.has(tab.id)) continue;
    if (typeof tab.url === 'string' && tab.url.startsWith(EXTENSION_ORIGIN)) continue;
    if (!settingsCache.enabled || tab.discarded) {
      applyBadge(tab.id, empty);
    } else {
      refreshTab(tab.id).catch(() => {});
    }
  }
}

function scheduleNotify(tabId) {
  if (notifyTimers.has(tabId)) return;
  notifyTimers.set(
    tabId,
    setTimeout(async () => {
      notifyTimers.delete(tabId);
      await settingsReady;
      const entry = tabCache.get(tabId);
      if (!entry) return;
      const state = aggregate(entry.frames);
      applyBadge(tabId, state);
      notifyPopup(tabId, state);
    }, NOTIFY_DELAY_MS)
  );
}

function notifyPopup(tabId, state) {
  chrome.runtime.sendMessage({ type: MSG.tabStateChanged, tabId, state }).catch(() => {});
}

// ---------------------------------------------------------------------------
// タブの遷移・削除
// ---------------------------------------------------------------------------

// 遷移で古い文書の報告は、消滅報告・documentId・トップ文書の交代（mergeFrame）で捨てる。
// 読み込み完了時は、状態を持っていたタブだけ実フレームへ照会し直す
// （移動先で content script が動かないページ・消滅報告が届かなかった場合も古い値を残さない）。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    lastBadge.delete(tabId);
  } else if (changeInfo.status === 'complete' && tabCache.has(tabId)) {
    scheduleRefresh(tabId);
  }
});

function cleanupTab(tabId) {
  tabCache.delete(tabId);
  lastBadge.delete(tabId);
  tabSpeedSeq.delete(tabId);
  clearTimeout(notifyTimers.get(tabId));
  notifyTimers.delete(tabId);
  clearTimeout(refreshTimers.get(tabId));
  refreshTimers.delete(tabId);
}

chrome.tabs.onRemoved.addListener(cleanupTab);
chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => cleanupTab(removedTabId));

chrome.tabs.onActivated.addListener(({ tabId }) => {
  refreshTab(tabId).catch(() => {});
});

// ---------------------------------------------------------------------------
// メッセージ
// ---------------------------------------------------------------------------

function fromExtensionPage(sender) {
  return typeof sender.url === 'string' && sender.url.startsWith(EXTENSION_ORIGIN);
}

function respond(promise, sendResponse) {
  promise.then(sendResponse, (error) => {
    sendResponse({ ok: false, error: String((error && error.message) || error) });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id) return false;
  const page = fromExtensionPage(sender);

  switch (msg.type) {
    case MSG.reportState:
      if (!page) handleReport(msg, sender);
      return false;

    case MSG.saveSettings: {
      let patch = msg.patch;
      // 動画上パネルから保存できるのは速度だけ
      if (!page) patch = patch && typeof patch === 'object' && 'speed' in patch ? { speed: patch.speed } : null;
      respond(
        enqueueSave(patch).then((result) => ({ ok: true, ...result })),
        sendResponse
      );
      return true;
    }

    case MSG.getTabState:
      if (!page) return false;
      respond(getTabState(msg.tabId), sendResponse);
      return true;

    case MSG.setTabSpeed:
      if (!page) return false;
      respond(setTabSpeed(msg.tabId, msg.speed), sendResponse);
      return true;

    default:
      return false;
  }
});
