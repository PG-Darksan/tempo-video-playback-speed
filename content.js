/*
 * 動画再生速度変更 — content script（フレームごとに1つ）
 *  - video 要素の検出（初期走査・後から追加・open Shadow DOM）と後処理
 *  - 動画ごとの基準速度と所有権（OFF時に拡張機能が変えた動画だけ戻す）
 *  - 動画上パネル（独自要素＋open Shadow DOM）と淡い復帰アイコン
 *  - Service Worker への実状態の上り報告
 */
(() => {
  'use strict';

  const S = globalThis.TempoShared;
  const I = globalThis.TempoI18n;
  if (!S || !I) return;

  // 二重初期化の防止
  if (globalThis.__tempoContent && globalThis.__tempoContent.alive) return;
  const instance = { alive: true };
  globalThis.__tempoContent = instance;

  const { MSG, KEYS } = S;
  const HOST_TAG = 'tempo-speed-panel';
  const IS_TOP = window === window.top;
  let startedAt = Math.round(performance.timeOrigin || Date.now());
  const REPORT_DELAY_MS = 40;
  const SAVE_DELAY_MS = 120;
  const SWEEP_DELAY_MS = 80;
  const VERIFY_DELAY_MS = 40;
  const RATE_EVENT_TIMEOUT_MS = 300;
  const LAYOUT_INTERVAL_MS = 800;
  const MIN_PANEL_WIDTH = 185;
  const MIN_PANEL_HEIGHT = 88;
  const PANEL_OFFSET = 10;
  const PANEL_EDGE = 8;

  const state = {
    settings: { ...S.DEFAULT_SETTINGS },
    languagePref: 'auto',
    lang: I.resolve('auto'),
    loaded: false
  };

  /** HTMLVideoElement -> Entry */
  const entries = new Map();
  /** 一時的に DOM から外れた動画の所有権（付け直されたときに引き継ぐ） */
  const ownership = new WeakMap();
  /** Document / ShadowRoot -> MutationObserver */
  const mutationObservers = new Map();
  const deferred = [];
  const globalListeners = new AbortController();
  let sentAnyReport = false;
  let reportTimer = 0;
  let reportForced = false;
  let sweepTimer = 0;
  let layoutFrame = 0;
  let layoutInterval = 0;
  let saveTimer = 0;
  let pendingSaveSpeed = null;

  const resizeObserver = new ResizeObserver(() => scheduleLayout());

  // -------------------------------------------------------------------------
  // 拡張機能との接続
  // -------------------------------------------------------------------------

  function contextValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function send(message) {
    if (!instance.alive) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage(message).catch(() => {
        if (!contextValid()) teardown();
        return null;
      });
    } catch (_) {
      teardown();
      return Promise.resolve(null);
    }
  }

  function whenLoaded(fn) {
    if (state.loaded) fn();
    else deferred.push(fn);
  }

  // -------------------------------------------------------------------------
  // 設定と言語（初期読込より先に変更を購読する）
  // -------------------------------------------------------------------------

  let settingsVersion = 0;
  let languageVersion = 0;

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !instance.alive) return;
    if (changes[KEYS.settings]) {
      settingsVersion += 1;
      const prev = state.settings;
      const next = S.sanitizeSettings(changes[KEYS.settings].newValue);
      state.settings = next;
      if (state.loaded) onSettingsChanged(prev, next);
    }
    if (changes[KEYS.language]) {
      languageVersion += 1;
      setLanguage(changes[KEYS.language].newValue);
    }
  }

  function onSettingsChanged(prev, next) {
    if (prev.enabled && !next.enabled) {
      disableAll();
    } else if (!prev.enabled && next.enabled) {
      // OFF→ON は記憶設定に関係なく既存動画へ保存速度を適用
      enableAll(next.speed);
    }
    // 保存速度だけの変更では既存動画を変えない（記憶ONなら以後の新規検出・metadataで使う）
    // 表示の切替は描画を待たずに反映する（裏のタブでは requestAnimationFrame が止まるため）
    if (prev.showOverlay !== next.showOverlay || prev.enabled !== next.enabled) layoutAll();
    updateLayoutInterval();
  }

  function setLanguage(pref) {
    state.languagePref = I.sanitizePreference(pref);
    state.lang = I.resolve(state.languagePref);
    for (const entry of entries.values()) if (entry.panel) entry.panel.render();
  }

  chrome.storage.onChanged.addListener(onStorageChanged);

  {
    const sv = settingsVersion;
    const lv = languageVersion;
    chrome.storage.local
      .get([KEYS.settings, KEYS.language])
      .then(
        (stored) => {
          if (sv === settingsVersion) state.settings = S.sanitizeSettings(stored[KEYS.settings]);
          if (lv === languageVersion) setLanguage(stored[KEYS.language]);
        },
        () => {}
      )
      .finally(start);
  }

  function start() {
    if (!instance.alive || state.loaded) return;
    state.loaded = true;
    if (document.documentElement) scan(document);
    installGlobalListeners();
    updateLayoutInterval();
    scheduleLayout();
    // トップフレームは動画の有無にかかわらず1回報告する（遷移後の古い状態を消すため）
    if (IS_TOP || entries.size) scheduleReport(true);
    while (deferred.length) deferred.shift()();
  }

  // -------------------------------------------------------------------------
  // 動画の検出
  // -------------------------------------------------------------------------

  function isVideo(node) {
    return !!node && node.nodeType === 1 && node.localName === 'video' && 'playbackRate' in node;
  }

  /** video.srcObject がリアルタイムの MediaStream（WebRTC・カメラ・画面共有など）か。 */
  function isMediaStream(srcObject) {
    if (!srcObject || typeof srcObject !== 'object') return false;
    if (typeof MediaStream === 'function' && srcObject instanceof MediaStream) return true;
    if (Object.prototype.toString.call(srcObject) === '[object MediaStream]') return true;
    return typeof srcObject.getTracks === 'function' && typeof srcObject.getVideoTracks === 'function';
  }

  /** 再生対象となるメディアソース（src / source / srcObject / 読込済みデータ）を持つか。 */
  function hasMediaSource(video) {
    if (video.srcObject != null) return true;
    const srcAttr = video.getAttribute('src');
    if (srcAttr && srcAttr.trim() !== '') return true;
    for (const child of video.children) {
      if (child.localName === 'source') {
        const s = child.getAttribute('src');
        if (s && s.trim() !== '') return true;
      }
    }
    if (video.readyState > 0) return true;
    // ソース削除後に networkState === 0 (NETWORK_EMPTY) のまま残る古い currentSrc を除外する
    return !!video.currentSrc && video.networkState !== 0;
  }

  function videoSrcKey(video) {
    if (video.currentSrc && video.networkState !== 0) return video.currentSrc;
    const attr = video.getAttribute('src');
    if (attr && attr.trim() !== '') return video.src || attr.trim();
    for (const child of video.children) {
      if (child.localName === 'source') {
        const s = child.getAttribute('src');
        if (s && s.trim() !== '') return child.src || s.trim();
      }
    }
    return '';
  }

  /**
   * リアルタイム双方向通信（MediaStream）・ソース未設定・再生不可の要素か。
   * これらは再生速度制御の対象外とし、速度適用・パネル表示・動画カウントを行わない。
   */
  function isRealtimeOrEmpty(video) {
    if (isMediaStream(video.srcObject)) return true;
    const src = video.currentSrc || video.getAttribute('src') || '';
    if (/^mediastream:/i.test(src.trim())) return true;
    if (!hasMediaSource(video)) return true;
    if (video.error && video.readyState === 0) return true;
    if (video.readyState >= 1 && video.duration === 0) return true;
    return false;
  }

  /** playbackRate プロパティ自体が読み取り専用に固定されているか（書き込みせず検査）。 */
  function isPlaybackRateLocked(video) {
    for (let obj = video; obj && obj !== Object.prototype; obj = Object.getPrototypeOf(obj)) {
      const desc = Object.getOwnPropertyDescriptor(obj, 'playbackRate');
      if (desc) {
        if ('get' in desc || 'set' in desc) return typeof desc.set !== 'function';
        return desc.writable === false;
      }
    }
    return false;
  }

  function safeRate(video) {
    try {
      const rate = video.playbackRate;
      return typeof rate === 'number' && Number.isFinite(rate) ? rate : 1;
    } catch (_) {
      return 1;
    }
  }

  function observeRoot(root) {
    if (mutationObservers.has(root)) return;
    const observer = new MutationObserver(onMutations);
    observer.observe(root, { childList: true, subtree: true });
    mutationObservers.set(root, observer);
  }

  /** 文書から外れた Shadow root の監視を外す（付け直されたら再走査で付け直す）。 */
  function releaseDetachedRoots() {
    for (const [root, observer] of mutationObservers) {
      if (root !== document && !root.host.isConnected) {
        observer.disconnect();
        mutationObservers.delete(root);
      }
    }
  }

  /** root (Document / ShadowRoot / Element) 以下の動画と open Shadow DOM を走査する。 */
  function scan(root) {
    if (!root) return;
    if (root.nodeType === 1) {
      if (root.localName === HOST_TAG) return;
      if (isVideo(root)) registerVideo(root);
      if (root.shadowRoot) scan(root.shadowRoot);
    } else {
      observeRoot(root);
    }
    if (typeof root.querySelectorAll !== 'function') return;
    for (const video of root.querySelectorAll('video')) registerVideo(video);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => (node.localName === HOST_TAG ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.shadowRoot) scan(node.shadowRoot);
    }
  }

  function onMutations(records) {
    if (!instance.alive) return;
    if (!contextValid()) {
      teardown();
      return;
    }
    let removed = false;
    const sourceTargets = new Set();
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1 && node.localName !== HOST_TAG) scan(node);
      }
      if (record.removedNodes.length) removed = true;
      if (entries.has(record.target)) sourceTargets.add(record.target);
    }
    for (const video of sourceTargets) {
      const entry = entries.get(video);
      if (entry) syncVideoSource(entry, { applyRemember: true });
    }
    if (removed) scheduleSweep();
  }

  /** 別の文書へ移った動画（Document Picture-in-Picture など）もこのフレームの対象外。 */
  function isInThisDocument(video) {
    return video.isConnected && video.ownerDocument === document;
  }

  /** 削除（移動ではない）された動画と、外れた Shadow root の後処理。 */
  function scheduleSweep() {
    if (sweepTimer) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = 0;
      for (const video of [...entries.keys()]) if (!isInThisDocument(video)) unregisterVideo(video);
      releaseDetachedRoots();
      scheduleLayout();
    }, SWEEP_DELAY_MS);
  }

  function syncVideoSource(entry, { emptied = false, applyRemember = false } = {}) {
    const video = entry.video;
    const prevControllable = entry.controllable;
    const nowControllable = !isRealtimeOrEmpty(video);
    const curSrc = videoSrcKey(video);
    const curSrcObject = video.srcObject || null;
    const sourceChanged = emptied || curSrc !== entry.lastSrc || curSrcObject !== entry.lastSrcObject;

    entry.controllable = nowControllable;
    entry.lastSrc = curSrc;
    entry.lastSrcObject = curSrcObject;

    if (!nowControllable) {
      // リアルタイム通信（MediaStream）や空ソースへ切り替わったら制御対象から外す
      clearTimeout(entry.verifyTimer);
      entry.verifyTimer = 0;
      entry.target = null;
      entry.rejected = false;
      entry.rejectedRate = null;
      entry.awaitingRateEvent = false;
      if (isOwned(entry)) {
        try {
          video.playbackRate = entry.baselineRate;
        } catch (_) {
          // プレーヤーが復元を拒否した
        }
        entry.appliedRate = null;
        entry.baselineRate = safeRate(video);
      }
      if (entry.panel) entry.panel.hide();
      if (prevControllable || entry.panel) {
        scheduleLayout();
        scheduleReport();
      }
      return { changed: prevControllable !== nowControllable, sourceChanged };
    }

    if (!prevControllable || sourceChanged) {
      if (!prevControllable) {
        entry.baselineRate = safeRate(video);
        entry.appliedRate = null;
      }
      entry.rejected = false;
      entry.rejectedRate = null;
      entry.target = null;
      if (applyRemember && state.settings.enabled && state.settings.rememberSpeed && !isPlaybackRateLocked(video)) {
        applySpeed(entry, state.settings.speed);
        scheduleVerify(entry);
        if (entry.panel) entry.panel.render();
      }
      scheduleLayout();
      scheduleReport();
    }
    return { changed: prevControllable !== nowControllable, sourceChanged };
  }

  function registerVideo(video) {
    if (!state.loaded || !instance.alive || entries.has(video) || !isVideo(video) || !isInThisDocument(video)) return;
    if (!contextValid()) {
      // 拡張機能の更新・無効化で文脈が失われた: 古い設定を適用せずに片付ける
      teardown();
      return;
    }
    const controllable = !isRealtimeOrEmpty(video);
    const rate = safeRate(video);
    // 一度外れて付け直された動画は、まだ拡張機能の速度のままなら所有権を引き継ぐ
    const kept = ownership.get(video);
    const keepOwnership = controllable && !!kept && kept.appliedRate != null && S.sameSpeed(rate, kept.appliedRate);
    const entry = {
      video,
      controllable,
      lastSrc: videoSrcKey(video),
      lastSrcObject: video.srcObject || null,
      baselineRate: keepOwnership ? kept.baselineRate : rate,
      appliedRate: keepOwnership ? kept.appliedRate : null,
      target: null,
      rejected: false,
      rejectedRate: null,
      awaitingRateEvent: false,
      lastOperatedAt: 0,
      onScreen: false,
      panel: null,
      listeners: new AbortController(),
      verifyTimer: 0
    };
    entries.set(video, entry);
    ownership.delete(video);
    // 外れている間に OFF になっていたら、ここで元の速度へ戻す
    if (keepOwnership && !state.settings.enabled) {
      try {
        video.playbackRate = entry.baselineRate;
      } catch (_) {
        // プレーヤーが復元を拒否した
      }
      entry.appliedRate = null;
      entry.baselineRate = safeRate(video);
    }
    const opts = { signal: entry.listeners.signal, passive: true };
    video.addEventListener('ratechange', () => onRateChange(entry), opts);
    video.addEventListener('loadedmetadata', () => onLoadedMetadata(entry), opts);
    video.addEventListener('loadstart', () => syncVideoSource(entry, { applyRemember: true }), opts);
    video.addEventListener('emptied', () => syncVideoSource(entry, { emptied: true }), opts);
    for (const type of ['loadeddata', 'canplay', 'error']) {
      video.addEventListener(type, () => {
        syncVideoSource(entry);
        scheduleLayout();
        scheduleReport();
      }, opts);
    }
    for (const type of ['play', 'playing', 'pause', 'ended']) {
      video.addEventListener(type, () => {
        syncVideoSource(entry);
        if (type === 'playing') scheduleLayout();
        scheduleReport();
      }, opts);
    }
    resizeObserver.observe(video);
    if (controllable && state.settings.enabled && state.settings.rememberSpeed && !isPlaybackRateLocked(video)) {
      applySpeed(entry, state.settings.speed);
      scheduleVerify(entry);
    }
    updateLayoutInterval();
    scheduleLayout();
    scheduleReport();
  }

  function unregisterVideo(video) {
    const entry = entries.get(video);
    if (!entry) return;
    ownership.set(video, { baselineRate: entry.baselineRate, appliedRate: entry.appliedRate });
    entry.listeners.abort();
    clearTimeout(entry.verifyTimer);
    resizeObserver.unobserve(video);
    if (entry.panel) entry.panel.destroy();
    entries.delete(video);
    updateLayoutInterval();
    scheduleReport();
  }

  // -------------------------------------------------------------------------
  // 速度と所有権
  // -------------------------------------------------------------------------

  function isOwned(entry) {
    return entry.appliedRate != null && S.sameSpeed(safeRate(entry.video), entry.appliedRate);
  }

  /** 拡張機能として速度を適用する。未所有なら直前の実速度を基準にする。 */
  function applySpeed(entry, speed) {
    const video = entry.video;
    const prevApplied = entry.appliedRate;
    const prevBaseline = entry.baselineRate;
    const before = safeRate(video);
    if (!isOwned(entry)) entry.baselineRate = before;
    entry.appliedRate = speed;
    entry.target = speed;
    try {
      video.playbackRate = speed;
      // 値が変われば ratechange が後から届く。サイトが戻すならその処理の後に確かめる
      if (!S.sameSpeed(before, safeRate(video))) entry.awaitingRateEvent = true;
    } catch (_) {
      entry.appliedRate = prevApplied;
      entry.baselineRate = prevBaseline;
    }
    const after = safeRate(video);
    const wasRejected = entry.rejected;
    entry.rejected = !S.sameSpeed(after, speed);
    entry.rejectedRate = entry.rejected ? after : null;
    if (entry.rejected !== wasRejected) {
      if (entry.rejected && entry.panel) entry.panel.hide();
      scheduleLayout();
    }
    return !entry.rejected;
  }

  /**
   * 速度を変えた動画の ratechange が配送され終わってから callback を呼ぶ。
   * サイトが ratechange の中で速度を戻す場合も、戻した後の実速度で判定できる。
   */
  function whenRateSettled(list, callback) {
    if (!list.some((e) => e.awaitingRateEvent && e.video.isConnected && entries.has(e.video))) {
      callback();
      return;
    }
    const started = Date.now();
    const check = () => {
      const waiting = list.some((e) => e.awaitingRateEvent && e.video.isConnected && entries.has(e.video));
      if (waiting && Date.now() - started < RATE_EVENT_TIMEOUT_MS) {
        setTimeout(check, 20);
        return;
      }
      callback();
    };
    setTimeout(check, VERIFY_DELAY_MS);
  }

  /** サイト側が ratechange で戻す場合に備え、少し後に実速度を確かめる。 */
  function scheduleVerify(entry) {
    clearTimeout(entry.verifyTimer);
    entry.verifyTimer = setTimeout(() => {
      entry.verifyTimer = 0;
      whenRateSettled([entry], () => {
        verify(entry);
        if (entry.panel) entry.panel.render();
      });
    }, 0);
  }

  function verify(entry) {
    if (entry.target != null) {
      const rate = safeRate(entry.video);
      const wasRejected = entry.rejected;
      entry.rejected = !S.sameSpeed(rate, entry.target);
      entry.rejectedRate = entry.rejected ? rate : null;
      if (entry.rejected !== wasRejected) {
        if (entry.rejected && entry.panel) entry.panel.hide();
        scheduleLayout();
      }
    }
  }

  function onRateChange(entry) {
    entry.awaitingRateEvent = false;
    if (isRealtimeOrEmpty(entry.video)) return;
    const rate = safeRate(entry.video);
    if (entry.appliedRate != null && !S.sameSpeed(rate, entry.appliedRate)) {
      // サイトや利用者のネイティブ操作: その値を新基準として所有を解除
      entry.baselineRate = rate;
      entry.appliedRate = null;
    }
    if (entry.rejected) {
      const matchedTarget = entry.target != null && S.sameSpeed(rate, entry.target);
      const movedAway = entry.rejectedRate != null && !S.sameSpeed(rate, entry.rejectedRate);
      if (matchedTarget || movedAway) {
        entry.rejected = false;
        entry.rejectedRate = null;
        scheduleLayout();
      }
    }
    if (entry.panel) entry.panel.render();
    scheduleReport();
  }

  function onLoadedMetadata(entry) {
    if (!contextValid()) {
      teardown();
      return;
    }
    syncVideoSource(entry);
    if (isRealtimeOrEmpty(entry.video)) return;
    if (state.settings.enabled && state.settings.rememberSpeed && !isPlaybackRateLocked(entry.video)) {
      applySpeed(entry, state.settings.speed);
      scheduleVerify(entry);
      if (entry.panel) entry.panel.render();
    }
    scheduleLayout();
    scheduleReport();
  }

  function disableAll() {
    for (const entry of entries.values()) {
      const video = entry.video;
      if (!isRealtimeOrEmpty(video) && isOwned(entry)) {
        try {
          video.playbackRate = entry.baselineRate;
        } catch (_) {
          // プレーヤーが復元を拒否した
        }
      }
      entry.appliedRate = null;
      entry.baselineRate = safeRate(video);
      entry.target = null;
      entry.rejected = false;
      entry.rejectedRate = null;
      clearTimeout(entry.verifyTimer);
      entry.verifyTimer = 0;
      if (entry.panel) entry.panel.resetEditing();
    }
    scheduleLayout();
    scheduleReport(true);
  }

  function enableAll(speed) {
    for (const entry of entries.values()) {
      syncVideoSource(entry);
      if (isRealtimeOrEmpty(entry.video) || isPlaybackRateLocked(entry.video)) continue;
      applySpeed(entry, speed);
      scheduleVerify(entry);
      if (entry.panel) entry.panel.render();
    }
    scheduleLayout();
    scheduleReport(true);
  }

  /** ポップアップからの速度指示: このフレームで検出済みの全動画へ。 */
  function handleSetSpeed(msg) {
    const speed = S.normalizeSpeed(msg.speed);
    const targets = [];
    if (speed != null && state.settings.enabled) {
      scan(document);
      for (const entry of entries.values()) {
        syncVideoSource(entry);
        if (isRealtimeOrEmpty(entry.video)) continue;
        clearTimeout(entry.verifyTimer);
        entry.verifyTimer = 0;
        applySpeed(entry, speed);
        if (entry.panel) entry.panel.resetEditing();
        targets.push(entry);
      }
    }
    whenRateSettled(targets, () => {
      for (const entry of targets) {
        verify(entry);
        if (entry.panel) entry.panel.render();
      }
      scheduleLayout();
      sendReport(msg.requestId, true);
    });
  }

  /** 動画上パネルからの操作: その動画1個だけ。保存速度も更新する。 */
  function overlaySetSpeed(entry, speed) {
    if (!state.settings.enabled || isRealtimeOrEmpty(entry.video)) return;
    const value = S.round2(S.clampSpeed(speed));
    entry.lastOperatedAt = Date.now();
    applySpeed(entry, value);
    scheduleVerify(entry);
    queueSaveSpeed(value);
    if (entry.panel) entry.panel.render();
    scheduleReport();
  }

  function queueSaveSpeed(speed) {
    pendingSaveSpeed = speed;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      const value = pendingSaveSpeed;
      pendingSaveSpeed = null;
      if (value != null) send({ type: MSG.saveSettings, patch: { speed: value } });
    }, SAVE_DELAY_MS);
  }

  // -------------------------------------------------------------------------
  // 報告
  // -------------------------------------------------------------------------

  function isPlaying(video) {
    return !video.paused && !video.ended;
  }

  function isRendered(element) {
    if (typeof element.checkVisibility !== 'function') return true;
    return element.checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true,
      opacityProperty: true,
      visibilityProperty: true
    });
  }

  function viewportSize() {
    const root = document.documentElement;
    return {
      width: (root && root.clientWidth) || window.innerWidth,
      height: (root && root.clientHeight) || window.innerHeight
    };
  }

  function isOnScreen(video, rect) {
    const r = rect || video.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) return false;
    return isRendered(video);
  }

  /** フレーム内の代表: 再生中を優先し、その中で最後に操作 → 画面内 → 先頭。 */
  function pickRepresentative(list) {
    if (!list.length) return null;
    const playing = list.filter((e) => isPlaying(e.video));
    const pool = playing.length ? playing : list;
    let operated = null;
    for (const e of pool) if (e.lastOperatedAt > 0 && (!operated || e.lastOperatedAt > operated.lastOperatedAt)) operated = e;
    if (operated) return operated;
    return pool.find((e) => isOnScreen(e.video)) || pool[0];
  }

  function buildReport(extra) {
    const list = [...entries.values()].filter((e) => isInThisDocument(e.video) && !isRealtimeOrEmpty(e.video));
    const rep = pickRepresentative(list);
    return {
      videoCount: list.length,
      rates: list.map((e) => safeRate(e.video)),
      speed: rep ? safeRate(rep.video) : null,
      playing: rep ? isPlaying(rep.video) : false,
      visible: rep ? isOnScreen(rep.video) : false,
      startedAt,
      observedAt: Date.now(),
      ...(extra || {})
    };
  }

  function scheduleReport(force) {
    if (force) reportForced = true;
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = 0;
      const forced = reportForced;
      reportForced = false;
      sendReport(null, forced);
    }, REPORT_DELAY_MS);
  }

  function sendReport(requestId, force) {
    if (!instance.alive) return;
    const report = buildReport();
    // 動画を一度も持たないサブフレームは、照会されない限り黙っている
    if (!requestId && !force && !IS_TOP && !sentAnyReport && report.videoCount === 0) return;
    sentAnyReport = true;
    send({ type: MSG.reportState, requestId: requestId || null, report });
  }

  // -------------------------------------------------------------------------
  // 動画上パネルの配置
  // -------------------------------------------------------------------------

  function deepFullscreenElement() {
    let element = document.fullscreenElement || document.webkitFullscreenElement;
    while (element && element.shadowRoot && (element.shadowRoot.fullscreenElement || element.shadowRoot.webkitFullscreenElement)) {
      element = element.shadowRoot.fullscreenElement || element.shadowRoot.webkitFullscreenElement;
    }
    return element || null;
  }

  function composedContains(ancestor, node) {
    for (let n = node; n; n = n.parentNode || n.host || null) {
      if (n === ancestor) return true;
    }
    return false;
  }

  function scheduleLayout() {
    if (layoutFrame || !instance.alive) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      layoutAll();
    });
  }

  function layoutAll() {
    if (!instance.alive) return;
    const fullscreen = deepFullscreenElement();
    const viewport = viewportSize();
    let visibilityChanged = false;
    for (const entry of entries.values()) {
      const video = entry.video;
      if (!isInThisDocument(video)) {
        if (entry.panel) entry.panel.hide();
        scheduleSweep();
        continue;
      }
      const realtimeOrEmpty = isRealtimeOrEmpty(video);
      if (realtimeOrEmpty !== !entry.controllable) {
        syncVideoSource(entry);
      }
      const canShowPanel = !realtimeOrEmpty && !entry.rejected && !isPlaybackRateLocked(video);
      const rect = video.getBoundingClientRect();
      const onScreen = !realtimeOrEmpty && isOnScreen(video, rect);
      if (onScreen !== entry.onScreen) {
        entry.onScreen = onScreen;
        visibilityChanged = true;
      }
      let parent = null;
      if (state.settings.enabled && state.settings.showOverlay && canShowPanel && onScreen &&
          rect.width >= MIN_PANEL_WIDTH && rect.height >= MIN_PANEL_HEIGHT) {
        if (!fullscreen) parent = document.documentElement;
        else if (fullscreen !== video && composedContains(fullscreen, video)) {
          // Shadow host そのものが全画面なら、子要素は slot が無いと描画されないので root へ入れる
          parent = fullscreen.shadowRoot || fullscreen;
        }
        // video 自体の全画面や、別要素の全画面では隠す
      }
      if (parent) {
        if (!entry.panel) entry.panel = new Panel(entry);
        entry.panel.place(rect, parent, viewport);
      } else if (entry.panel) {
        entry.panel.hide();
      }
    }
    if (visibilityChanged) scheduleReport();
  }

  function updateLayoutInterval() {
    const wanted = instance.alive && entries.size > 0 && state.settings.enabled && state.settings.showOverlay;
    if (wanted && !layoutInterval) {
      layoutInterval = setInterval(() => {
        if (!contextValid()) {
          teardown();
          return;
        }
        scheduleLayout();
      }, LAYOUT_INTERVAL_MS);
    } else if (!wanted && layoutInterval) {
      clearInterval(layoutInterval);
      layoutInterval = 0;
    }
  }

  function syncSettingsFromStorage() {
    if (!instance.alive || !contextValid()) {
      teardown();
      return;
    }
    const sv = settingsVersion;
    const lv = languageVersion;
    chrome.storage.local
      .get([KEYS.settings, KEYS.language])
      .then(
        (stored) => {
          if (!instance.alive) return;
          if (sv === settingsVersion) {
            const prev = state.settings;
            const next = S.sanitizeSettings(stored[KEYS.settings]);
            state.settings = next;
            if (prev.enabled !== next.enabled || prev.showOverlay !== next.showOverlay ||
                prev.rememberSpeed !== next.rememberSpeed || prev.speed !== next.speed) {
              onSettingsChanged(prev, next);
            }
          }
          if (lv === languageVersion) {
            const pref = I.sanitizePreference(stored[KEYS.language]);
            if (pref !== state.languagePref) setLanguage(pref);
          }
          layoutAll();
          scheduleReport(true);
        },
        () => {
          if (!contextValid()) teardown();
        }
      );
  }

  function installGlobalListeners() {
    const opts = { signal: globalListeners.signal, passive: true };
    const capture = { ...opts, capture: true };
    window.addEventListener('resize', scheduleLayout, opts);
    document.addEventListener('scroll', scheduleLayout, capture);
    document.addEventListener('fullscreenchange', scheduleLayout, capture);
    document.addEventListener('webkitfullscreenchange', scheduleLayout, capture);
    // MutationObserver より先に再生が始まった動画を拾う
    const pickUp = (event) => {
      if (isVideo(event.target) && !entries.has(event.target)) registerVideo(event.target);
    };
    document.addEventListener('loadedmetadata', pickUp, capture);
    document.addEventListener('play', pickUp, capture);
    window.addEventListener('pagehide', () => {
      if (IS_TOP || sentAnyReport) send({ type: MSG.reportState, requestId: null, report: buildReport({ gone: true }) });
    }, opts);
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      // bfcache 復元時は凍結中に見逃した設定変更と document 世代を再同期する
      startedAt = Math.max(startedAt + 1, Date.now());
      syncSettingsFromStorage();
    }, opts);
    // 事前レンダリング中の報告は Service Worker が受け取らないので、表示されたら報告し直す
    if (document.prerendering) {
      document.addEventListener('prerenderingchange', () => scheduleReport(true), { ...opts, once: true });
    }
  }

  // -------------------------------------------------------------------------
  // 動画上パネル
  // -------------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HOST_STYLE = [
    'all: initial !important',
    'position: fixed !important',
    'top: 0 !important',
    'left: 0 !important',
    'width: 0 !important',
    'height: 0 !important',
    'overflow: visible !important',
    'z-index: 2147483647 !important',
    'pointer-events: none !important',
    'display: block !important'
  ].join(';');

  const PANEL_CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.panel {
  pointer-events: auto;
  display: inline-flex;
  flex-direction: column;
  max-width: calc(100vw - 16px);
  padding: 3px;
  font: 13px/1.25 "Segoe UI", "Yu Gothic UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif;
  font-variant-numeric: tabular-nums;
  color: #f4faf9;
  background: rgba(18, 31, 35, .94);
  border: 1px solid rgba(255, 255, 255, .18);
  border-radius: 13px;
  box-shadow: 0 5px 22px #0005;
  user-select: none;
  -webkit-user-select: none;
  -webkit-font-smoothing: antialiased;
  cursor: default;
  transition: background-color .15s ease, border-color .15s ease;
}
.row { display: flex; align-items: center; gap: 2px; }
button {
  appearance: none;
  margin: 0;
  border: 0;
  height: 29px;
  min-width: 29px;
  padding: 0 8px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1;
  cursor: pointer;
  transition: background-color .15s ease, color .15s ease;
}
button:hover:not(:disabled) { background: rgba(255, 255, 255, .12); }
button:focus { outline: none; }
button:focus-visible { outline: 2px solid #75e0ce; outline-offset: 1px; }
button:disabled { opacity: .38; cursor: default; }
.step { font-size: 17px; font-weight: 500; padding: 0; }
.rate { min-width: 58px; padding: 0 6px; font-size: 14px; font-weight: 650; }
.num { direction: ltr; unicode-bidi: isolate; }
.icon { padding: 0; }
.icon svg { width: 14px; height: 14px; display: block; }
.toggle svg { transition: transform .15s ease; }
.toggle[aria-expanded="true"] svg { transform: rotate(180deg); }
.details {
  width: 236px;
  max-width: calc(100vw - 24px);
  margin-top: 3px;
  padding: 7px 5px 5px;
  border-top: 1px solid rgba(255, 255, 255, .12);
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.input-row { display: flex; align-items: center; gap: 6px; }
.input {
  flex: 1;
  min-width: 0;
  height: 29px;
  margin: 0;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, .22);
  background: rgba(255, 255, 255, .08);
  color: inherit;
  font: inherit;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  direction: ltr;
  user-select: text;
  -webkit-user-select: text;
}
.input:focus { outline: 2px solid #75e0ce; outline-offset: 0; }
.input[aria-invalid="true"] { border-color: #ff9d8f; }
.unit { font-size: 14px; opacity: .8; }
.error { color: #ffb4a8; font-size: 12px; line-height: 1.35; }
.slider {
  appearance: none;
  width: 100%;
  height: 6px;
  margin: 6px 0 0;
  border-radius: 3px;
  background: linear-gradient(to right, #75e0ce var(--progress, 0%), rgba(255, 255, 255, .22) var(--progress, 0%));
  cursor: pointer;
}
.panel[dir="rtl"] .slider {
  background: linear-gradient(to left, #75e0ce var(--progress, 0%), rgba(255, 255, 255, .22) var(--progress, 0%));
}
.slider::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #f4faf9;
  border: 3px solid #75e0ce;
}
.slider::-moz-range-track {
  height: 6px;
  border: 0;
  border-radius: 3px;
  background: transparent;
}
.slider::-moz-range-thumb {
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #f4faf9;
  border: 3px solid #75e0ce;
}
.slider:focus { outline: none; }
.slider:focus-visible { outline: 2px solid #75e0ce; outline-offset: 4px; }
.range { display: flex; justify-content: space-between; font-size: 11px; color: rgba(244, 250, 249, .7); }
.presets { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
.preset { min-width: 0; padding: 0; background: rgba(255, 255, 255, .08); }
.preset[aria-pressed="true"] { background: #75e0ce; color: #10302c; font-weight: 650; }
.preset[aria-pressed="true"]:hover { background: #8de8d8; }
.panel.folded {
  padding: 0;
  background: rgba(18, 31, 35, .24);
  border-color: rgba(255, 255, 255, .10);
  border-radius: 7px;
  box-shadow: none;
}
.panel.folded:hover, .panel.folded:has(.restore:focus-visible) {
  background: rgba(18, 31, 35, .68);
  border-color: rgba(255, 255, 255, .18);
}
.restore {
  width: 26px;
  height: 26px;
  min-width: 26px;
  padding: 0;
  border-radius: 6px;
  color: rgba(255, 255, 255, .65);
}
.restore:hover:not(:disabled), .panel.folded:hover .restore, .restore:focus-visible {
  background: transparent;
  color: #f4faf9;
}
.restore svg { width: 12px; height: 12px; display: block; }
@media (prefers-reduced-motion: reduce) {
  .panel, .panel * { transition: none !important; }
}
`;

  let sharedSheet = null;
  let adoptFailed = false;

  function adoptStyles(shadow) {
    if (!adoptFailed) {
      try {
        if (!sharedSheet) {
          sharedSheet = new CSSStyleSheet();
          sharedSheet.replaceSync(PANEL_CSS);
        }
        shadow.adoptedStyleSheets = [sharedSheet];
        return;
      } catch (_) {
        // 共有スタイルシートを使えない環境
        adoptFailed = true;
      }
    }
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);
  }

  /** 小さな DOM 組み立て（innerHTML を使わない）。 */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === 'text') node.textContent = value;
      else if (value === true) node.setAttribute(key, '');
      else if (value !== false && value != null) node.setAttribute(key, String(value));
    }
    for (const child of children || []) node.appendChild(child);
    return node;
  }

  function svg(viewBox, shapes, strokeWidth) {
    const root = document.createElementNS(SVG_NS, 'svg');
    root.setAttribute('viewBox', viewBox);
    root.setAttribute('fill', 'none');
    root.setAttribute('stroke', 'currentColor');
    root.setAttribute('stroke-width', String(strokeWidth));
    root.setAttribute('stroke-linecap', 'round');
    root.setAttribute('stroke-linejoin', 'round');
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('focusable', 'false');
    for (const [tag, attrs] of shapes) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, String(v));
      root.appendChild(shape);
    }
    return root;
  }

  /** 復帰アイコン: 線だけの調整記号（ブランドロゴ・再生三角形は使わない）。 */
  function restoreIcon() {
    return svg('0 0 16 16', [
      ['path', { d: 'M2 5h3m3 0h6M2 11h6m3 0h3' }],
      ['circle', { cx: 6.5, cy: 5, r: 1.5 }],
      ['circle', { cx: 9.5, cy: 11, r: 1.5 }]
    ], 1.3);
  }

  function chevronIcon() {
    return svg('0 0 16 16', [['path', { d: 'M4 6l4 4 4-4' }]], 1.6);
  }

  function foldIcon() {
    return svg('0 0 16 16', [['path', { d: 'M9.5 2.5v4h4M6.5 13.5v-4h-4' }]], 1.5);
  }

  const STOPPED_EVENTS = [
    'click', 'dblclick', 'auxclick', 'contextmenu',
    'pointerdown', 'pointerup', 'mousedown', 'mouseup',
    'touchstart', 'touchend', 'keydown', 'keyup', 'keypress'
  ];

  class Panel {
    constructor(entry) {
      this.entry = entry;
      this.folded = false;
      this.detailsOpen = false;
      this.dirty = false;
      this.inputError = false;
      this.shown = false;

      this.host = document.createElement(HOST_TAG);
      this.host.style.cssText = HOST_STYLE;
      this.shadow = this.host.attachShadow({ mode: 'open' });
      adoptStyles(this.shadow);
      this.build();
      this.render();
    }

    build() {
      const btn = (cls, text) => el('button', { type: 'button', class: cls, text });

      this.minus = btn('step minus', '−');
      this.rate = el('button', { type: 'button', class: 'rate' }, [this.rateText = el('span', { class: 'num' })]);
      this.plus = btn('step plus', '+');
      this.toggle = el('button', { type: 'button', class: 'icon toggle', 'aria-controls': 'tempo-details' }, [chevronIcon()]);
      this.fold = el('button', { type: 'button', class: 'icon fold', 'aria-controls': 'tempo-body' }, [foldIcon()]);
      const row = el('div', { class: 'row' }, [this.minus, this.rate, this.plus, this.toggle, this.fold]);

      this.input = el('input', {
        class: 'input',
        type: 'text',
        inputmode: 'decimal',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-describedby': 'tempo-error'
      });
      this.error = el('div', { class: 'error', id: 'tempo-error', role: 'alert', hidden: true });
      this.slider = el('input', {
        class: 'slider',
        type: 'range',
        min: S.MIN_SPEED,
        max: S.MAX_SPEED,
        step: S.SLIDER_STEP
      });
      const range = el('div', { class: 'range' }, [
        el('span', { class: 'num', text: `${S.formatShort(S.MIN_SPEED)}×` }),
        el('span', { class: 'num', text: `${S.formatShort(S.MAX_SPEED)}×` })
      ]);
      this.presetButtons = S.PRESETS.map((value) => {
        const b = el('button', { type: 'button', class: 'preset', 'aria-pressed': 'false' }, [
          el('span', { class: 'num', text: `${value}×` })
        ]);
        b.dataset.speed = String(value);
        return b;
      });
      this.presets = el('div', { class: 'presets', role: 'group' }, this.presetButtons);
      this.details = el('div', { class: 'details', id: 'tempo-details', hidden: true }, [
        el('div', { class: 'input-row' }, [this.input, el('span', { class: 'unit', text: '×', 'aria-hidden': 'true' })]),
        this.error,
        this.slider,
        range,
        this.presets
      ]);
      this.body = el('div', { class: 'body', id: 'tempo-body' }, [row, this.details]);
      this.restore = el('button', { type: 'button', class: 'restore', 'aria-controls': 'tempo-body', hidden: true }, [restoreIcon()]);
      this.panel = el('div', { class: 'panel', role: 'group' }, [this.body, this.restore]);
      this.shadow.appendChild(this.panel);

      // 親プレーヤーへの伝播を止める（再生／停止の誤発火を防ぐ）
      const stop = (event) => event.stopPropagation();
      for (const type of STOPPED_EVENTS) this.panel.addEventListener(type, stop);

      // open Shadow DOM なのでページのスクリプトからも要素に触れられる。
      // 利用者の操作（isTrusted）だけを受け付け、ページが共通の保存速度を書き換えられないようにする
      const on = (node, type, handler) => node.addEventListener(type, (event) => {
        if (event.isTrusted) handler(event);
      });
      const entry = this.entry;
      const current = () => safeRate(entry.video);
      on(this.minus, 'click', () => this.choose(Math.max(S.MIN_SPEED, S.round2(current() - S.STEP))));
      on(this.plus, 'click', () => this.choose(Math.min(S.MAX_SPEED, S.round2(current() + S.STEP))));
      on(this.rate, 'click', () => this.choose(1));
      on(this.toggle, 'click', () => {
        this.detailsOpen = !this.detailsOpen;
        this.render();
        scheduleLayout();
      });
      on(this.fold, 'click', () => {
        this.folded = true;
        this.render();
        scheduleLayout();
        this.restore.focus();
      });
      on(this.restore, 'click', () => {
        this.folded = false;
        this.render();
        scheduleLayout();
        this.fold.focus();
      });
      // パネル内の別ボタン押下中は blur 確定を pointerup 後まで遅らせ、エラー挿入の段ズレと誤確定を防ぐ
      let pointerDown = false;
      let pendingBlur = false;
      const finishPointer = () => {
        window.removeEventListener('pointerup', finishPointer, true);
        window.removeEventListener('pointercancel', finishPointer, true);
        window.removeEventListener('blur', finishPointer);
        if (!pointerDown) return;
        pointerDown = false;
        setTimeout(() => {
          if (!pendingBlur) return;
          pendingBlur = false;
          if (!instance.alive || !entries.has(entry.video)) return;
          if (this.shadow.activeElement !== this.input) this.commit();
        }, 0);
      };
      on(this.panel, 'pointerdown', (event) => {
        if (event.target === this.input) return;
        pointerDown = true;
        const capture = { capture: true, signal: entry.listeners.signal };
        window.addEventListener('pointerup', finishPointer, capture);
        window.addEventListener('pointercancel', finishPointer, capture);
        window.addEventListener('blur', finishPointer, { signal: entry.listeners.signal });
      });
      const commitOnBlur = () => {
        if (pointerDown) {
          pendingBlur = true;
          return;
        }
        this.commit();
      };
      on(this.input, 'input', () => {
        this.dirty = true;
      });
      on(this.input, 'keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault();
          this.commit();
        } else if (event.key === 'Escape') {
          if (this.dirty || this.inputError) event.preventDefault();
          this.resetEditing();
        }
      });
      on(this.input, 'change', commitOnBlur);
      on(this.input, 'blur', commitOnBlur);
      on(this.slider, 'input', () => this.choose(S.round2(Number(this.slider.value))));
      for (const b of this.presetButtons) {
        on(b, 'click', () => this.choose(Number(b.dataset.speed)));
      }
    }

    choose(speed) {
      this.dirty = false;
      this.inputError = false;
      overlaySetSpeed(this.entry, speed);
    }

    /** Enter / change / blur で確定。未編集なら何もしない（Enter 後の blur で二重適用しない）。 */
    commit() {
      if (!this.dirty) return;
      const value = S.parseSpeedInput(this.input.value);
      if (value == null) {
        this.inputError = true;
        this.render();
        scheduleLayout();
        return;
      }
      this.choose(value);
    }

    resetEditing() {
      this.dirty = false;
      this.inputError = false;
      this.render();
    }

    render() {
      const t = (key, params) => I.t(state.lang, key, params);
      const entry = this.entry;
      const rate = safeRate(entry.video);
      const short = `${S.formatShort(rate)}×`;

      this.panel.lang = I.htmlLang(state.lang);
      this.panel.dir = I.dir(state.lang);
      this.panel.setAttribute('aria-label', t('overlayRegion'));
      this.panel.classList.toggle('folded', this.folded);
      this.body.hidden = this.folded;
      this.restore.hidden = !this.folded;

      this.rateText.textContent = short;
      setLabel(this.rate, t('overlayCurrent', { speed: short }));
      setLabel(this.minus, t('decrease'));
      setLabel(this.plus, t('increase'));
      this.minus.disabled = rate <= S.MIN_SPEED + S.EPSILON;
      this.plus.disabled = rate >= S.MAX_SPEED - S.EPSILON;

      this.toggle.setAttribute('aria-expanded', String(this.detailsOpen));
      setLabel(this.toggle, t(this.detailsOpen ? 'hideDetails' : 'showDetails'));
      this.fold.setAttribute('aria-expanded', 'true');
      setLabel(this.fold, t('fold'));
      this.details.hidden = !this.detailsOpen;

      if (!this.dirty) this.input.value = S.formatShort(rate);
      this.input.setAttribute('aria-label', t('speedInput'));
      this.input.setAttribute('aria-invalid', String(this.inputError));
      const message = this.inputError ? t('errInput') : entry.rejected ? t('errCannotChange') : '';
      if (this.error.textContent !== message) this.error.textContent = message;
      this.error.hidden = message === '';

      const clamped = S.clampSpeed(rate);
      this.slider.value = String(clamped);
      this.slider.setAttribute('aria-label', t('speedSlider'));
      this.slider.setAttribute('aria-valuetext', short);
      this.slider.style.setProperty('--progress', `${((clamped - S.MIN_SPEED) / (S.MAX_SPEED - S.MIN_SPEED)) * 100}%`);

      this.presets.setAttribute('aria-label', t('presets'));
      for (const b of this.presetButtons) {
        const value = Number(b.dataset.speed);
        b.setAttribute('aria-pressed', String(S.sameSpeed(rate, value)));
        setLabel(b, t('presetLabel', { speed: `${value}×` }));
      }

      this.restore.setAttribute('aria-expanded', 'false');
      this.restore.setAttribute('aria-label', t('openController'));
      this.restore.title = `${t('openController')} · ${short}`;
    }

    place(rect, parent, viewport) {
      if (this.host.parentNode !== parent) parent.appendChild(this.host);
      if (!this.shown) {
        this.host.style.setProperty('display', 'block', 'important');
        this.shown = true;
      }
      const width = this.panel.offsetWidth;
      const height = this.panel.offsetHeight;
      const maxX = Math.max(PANEL_EDGE, viewport.width - width - PANEL_EDGE);
      const maxY = Math.max(PANEL_EDGE, viewport.height - height - PANEL_EDGE);
      const x = Math.round(Math.min(Math.max(rect.left + PANEL_OFFSET, PANEL_EDGE), maxX));
      const y = Math.round(Math.min(Math.max(rect.top + PANEL_OFFSET, PANEL_EDGE), maxY));
      const transform = `translate(${x}px, ${y}px)`;
      if (this.lastTransform !== transform) {
        this.host.style.setProperty('transform', transform, 'important');
        this.lastTransform = transform;
      }
    }

    hide() {
      if (!this.shown) return;
      // フォーカスがパネル内にあるまま隠れたらページへ戻す
      if (this.shadow.activeElement) this.shadow.activeElement.blur();
      this.host.style.setProperty('display', 'none', 'important');
      this.shown = false;
    }

    destroy() {
      this.host.remove();
    }
  }

  function setLabel(node, text) {
    if (node.getAttribute('aria-label') !== text) node.setAttribute('aria-label', text);
    if (node.title !== text) node.title = text;
  }

  // -------------------------------------------------------------------------
  // Service Worker からの指示
  // -------------------------------------------------------------------------

  function onMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string' || !instance.alive) return false;
    if (sender && sender.id !== chrome.runtime.id) return false;
    switch (msg.type) {
      case MSG.requestReport:
        sendResponse({ ok: true });
        whenLoaded(() => {
          scan(document);
          for (const e of entries.values()) syncVideoSource(e);
          const list = [...entries.values()];
          // 直前に速度を変えた動画があれば、サイト側の反応を待ってから報告する
          if (list.some((e) => e.awaitingRateEvent)) whenRateSettled(list, () => sendReport(msg.requestId, true));
          else sendReport(msg.requestId, true);
        });
        return false;
      case MSG.setSpeed:
        sendResponse({ ok: true });
        whenLoaded(() => handleSetSpeed(msg));
        return false;
      case MSG.getState:
        whenLoaded(() => {
          for (const e of entries.values()) syncVideoSource(e);
          sendResponse({ ok: true, report: buildReport() });
        });
        return true;
      default:
        return false;
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);

  // -------------------------------------------------------------------------
  // 後処理（拡張機能の更新・再読み込みで文脈が失われたとき）
  // -------------------------------------------------------------------------

  function teardown() {
    if (!instance.alive) return;
    instance.alive = false;
    for (const observer of mutationObservers.values()) observer.disconnect();
    mutationObservers.clear();
    resizeObserver.disconnect();
    globalListeners.abort();
    clearInterval(layoutInterval);
    clearTimeout(reportTimer);
    clearTimeout(sweepTimer);
    clearTimeout(saveTimer);
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    for (const entry of entries.values()) {
      entry.listeners.abort();
      clearTimeout(entry.verifyTimer);
      if (entry.panel) entry.panel.destroy();
    }
    entries.clear();
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch (_) {
      // 文脈が既に無い
    }
  }
})();
