/*
 * 動画再生速度変更 — ポップアップ
 * 保存速度（共通設定）と実速度（タブの動画から観測した値）を分けて扱う。
 */
(() => {
  'use strict';

  const S = globalThis.TempoShared;
  const I = globalThis.TempoI18n;
  const { MSG, KEYS } = S;

  const $ = (id) => document.getElementById(id);
  const els = {
    brand: $('brand'),
    status: $('status'),
    statusText: $('statusText'),
    enabled: $('enabled'),
    speedHeading: $('speedHeading'),
    reset: $('reset'),
    onView: $('onView'),
    offView: $('offView'),
    minus: $('minus'),
    plus: $('plus'),
    input: $('speedInput'),
    slider: $('slider'),
    presets: $('presets'),
    offValue: $('offValue'),
    savedLabel: $('savedLabel'),
    savedValue: $('savedValue'),
    notice: $('notice'),
    noticeText: $('noticeText'),
    reloadButton: $('reloadButton'),
    showOverlay: $('showOverlay'),
    showOverlayLabel: $('showOverlayLabel'),
    rememberSpeed: $('rememberSpeed'),
    rememberLabel: $('rememberLabel'),
    language: $('language'),
    languageLabel: $('languageLabel'),
    authorText: $('authorText'),
    authorHint: $('authorHint')
  };

  const ui = {
    ready: false,
    loadFailed: false,
    settings: { ...S.DEFAULT_SETTINGS },
    languagePref: 'auto',
    lang: I.resolve('auto'),
    /** { id, urlKind } — URL そのものは保持しない */
    tab: null,
    tabState: null,
    stateKnown: false,
    /** 操作値（取得後は代表動画の実速度、取得前は保存速度） */
    opValue: S.DEFAULT_SETTINGS.speed,
    dirty: false,
    inputError: false,
    /** 操作番号。新しい操作・照会のたびに増やし、古い応答を捨てる */
    seq: 0,
    speedPending: false,
    togglePending: false,
    desiredEnabled: null,
    reloadPending: false,
    ignoreBefore: 0,
    optimistic: {},
    languageSeq: 0,
    languagePending: false,
    saveError: false,
    reloadError: false,
    /** 直近の速度指示の結果 { target, applied, delivered } */
    opResult: null
  };

  const presetButtons = S.PRESETS.map((value) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset';
    button.dataset.speed = String(value);
    button.textContent = `${value}×`;
    button.disabled = true;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => requestSpeed(value));
    els.presets.appendChild(button);
    return button;
  });

  const t = (key, params) => I.t(ui.lang, key, params);

  // -------------------------------------------------------------------------
  // 通信
  // -------------------------------------------------------------------------

  function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
  }

  async function saveSettings(patch) {
    const keys = Object.keys(patch);
    try {
      const res = await sendMessage({ type: MSG.saveSettings, patch });
      if (!res || !res.ok) throw new Error((res && res.error) || 'save failed');
      for (const key of keys) {
        if (key === 'language') continue;
        ui.settings[key] = res.settings[key];
      }
      ui.saveError = false;
      return res;
    } catch (error) {
      ui.saveError = true;
      throw error;
    } finally {
      render();
    }
  }

  function displayEnabled() {
    return ui.togglePending ? ui.desiredEnabled : ui.settings.enabled;
  }

  function countApplied(state, target) {
    let applied = 0;
    if (!state || !Array.isArray(state.frames)) return 0;
    for (const frame of state.frames) {
      for (const rate of frame.rates || []) if (S.sameSpeed(rate, target)) applied += 1;
    }
    return applied;
  }

  /** 実状態を採用する。古い updatedAt・再読込前の状態は捨てる。 */
  function acceptState(state, force) {
    if (!state || state.ok === false) return false;
    if (!force && ui.tabState && state.updatedAt <= ui.tabState.updatedAt) return false;
    if (state.updatedAt < ui.ignoreBefore) return false;
    ui.tabState = state;
    ui.stateKnown = true;
    // 操作値は常に実速度へ合わせる（入力欄の文字は編集中なら render が上書きしない）
    if (state.speed != null) ui.opValue = state.speed;
    if (ui.opResult) {
      // 変更拒否は play/pause だけでは消さない。目標速度を観測したか動画が消えたら解消
      if (countApplied(state, ui.opResult.target) > 0 || state.videoCount === 0) ui.opResult = null;
    }
    return true;
  }

  async function refreshState() {
    // 速度指示の途中は照会しない（その応答が最新の実状態を運ぶ）
    if (!ui.ready || !ui.tab || !ui.settings.enabled || ui.speedPending) {
      render();
      return;
    }
    const seq = ++ui.seq;
    let state = null;
    try {
      state = await sendMessage({ type: MSG.getTabState, tabId: ui.tab.id });
    } catch (_) {
      state = null;
    }
    if (seq !== ui.seq || ui.speedPending || ui.togglePending || ui.reloadPending) return;
    if (state && state.ok !== false) {
      acceptState(state, true);
    } else {
      ui.tabState = { ok: false, connected: false, enabled: ui.settings.enabled, videoCount: 0, speed: null, frames: [], updatedAt: 0 };
      ui.stateKnown = true;
    }
    render();
  }

  // -------------------------------------------------------------------------
  // 操作
  // -------------------------------------------------------------------------

  function controlsLocked() {
    return !ui.ready || ui.loadFailed || ui.togglePending || !ui.settings.enabled;
  }

  function requestSpeed(value) {
    if (controlsLocked()) return;
    const speed = S.round2(S.clampSpeed(value));
    ui.dirty = false;
    ui.inputError = false;
    ui.opValue = speed;
    ui.opResult = null;
    const seq = ++ui.seq;
    ui.speedPending = !!ui.tab;
    render();

    // 速度指示と保存は即時に別々に送る。片方の失敗でもう片方を失わない
    saveSettings({ speed }).catch(() => {});
    if (!ui.tab) return;
    sendMessage({ type: MSG.setTabSpeed, tabId: ui.tab.id, speed }).then(
      (res) => {
        if (seq !== ui.seq) return;
        ui.speedPending = false;
        if (res && res.ok) {
          acceptState(res.state, true);
          ui.opResult = { target: speed, applied: res.applied, delivered: res.delivered };
          if (res.applied > 0) ui.opResult = null;
        } else {
          ui.opResult = { target: speed, applied: 0, delivered: false };
        }
        render();
      },
      () => {
        if (seq !== ui.seq) return;
        ui.speedPending = false;
        ui.opResult = { target: speed, applied: 0, delivered: false };
        render();
      }
    );
  }

  function commitInput() {
    if (!ui.dirty || controlsLocked()) return;
    const value = S.parseSpeedInput(els.input.value);
    if (value == null) {
      ui.inputError = true;
      render();
      return;
    }
    requestSpeed(value);
  }

  async function toggleEnabled() {
    if (!ui.ready || ui.loadFailed || ui.togglePending) {
      els.enabled.checked = displayEnabled();
      return;
    }
    const next = !ui.settings.enabled;
    ui.seq += 1;
    ui.togglePending = true;
    ui.desiredEnabled = next;
    ui.speedPending = false;
    ui.dirty = false;
    ui.inputError = false;
    ui.opResult = null;
    render();
    try {
      await saveSettings({ enabled: next });
    } catch (_) {
      // 表示は保存済み設定へ戻る
    }
    ui.togglePending = false;
    ui.desiredEnabled = null;
    ui.tabState = null;
    ui.stateKnown = false;
    ui.opValue = ui.settings.speed;
    render();
    if (ui.settings.enabled) {
      // content script が保存速度を適用してから照会する
      setTimeout(refreshState, 120);
    }
  }

  async function toggleSetting(key) {
    const input = els[key];
    if (!ui.ready || ui.loadFailed || !ui.settings.enabled || ui.togglePending || key in ui.optimistic) {
      input.checked = key in ui.optimistic ? ui.optimistic[key] : ui.settings[key];
      return;
    }
    ui.optimistic[key] = !ui.settings[key];
    render();
    try {
      await saveSettings({ [key]: ui.optimistic[key] });
    } catch (_) {
      // 失敗時は保存済みの値に戻す
    }
    delete ui.optimistic[key];
    render();
  }

  async function changeLanguage() {
    if (!ui.ready || ui.loadFailed) return;
    const value = I.sanitizePreference(els.language.value);
    const seq = ++ui.languageSeq;
    ui.languagePending = true;
    try {
      const res = await saveSettings({ language: value });
      if (seq !== ui.languageSeq) return;
      ui.languagePref = I.sanitizePreference(res.language);
    } catch (_) {
      if (seq !== ui.languageSeq) return;
      // 保存できなければ選択を確定しない
    }
    ui.languagePending = false;
    applyLanguage();
  }

  function waitForComplete(tabId, timeoutMs) {
    return new Promise((resolve) => {
      const done = () => {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      };
      const listener = (id, info) => {
        if (id === tabId && info.status === 'complete') done();
      };
      const timer = setTimeout(done, timeoutMs);
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  async function reloadTab() {
    if (!ui.tab || ui.reloadPending || ui.tab.urlKind !== 'web') return;
    ui.seq += 1;
    ui.speedPending = false;
    ui.reloadPending = true;
    ui.reloadError = false;
    ui.opResult = null;
    render();
    const tabId = ui.tab.id;
    let failed = false;
    try {
      const completed = waitForComplete(tabId, 15000);
      await chrome.tabs.reload(tabId);
      ui.ignoreBefore = Date.now();
      ui.tabState = null;
      ui.stateKnown = false;
      await completed;
    } catch (_) {
      failed = true;
    }
    ui.reloadPending = false;
    ui.reloadError = failed;
    render();
    if (!failed) refreshState();
  }

  // -------------------------------------------------------------------------
  // 表示
  // -------------------------------------------------------------------------

  function applyLanguage() {
    ui.lang = I.resolve(ui.languagePref);
    const root = document.documentElement;
    root.lang = I.htmlLang(ui.lang);
    root.dir = I.dir(ui.lang);
    document.title = t('extName');
    els.brand.textContent = t('extName');
    els.enabled.setAttribute('aria-label', t('enableLabel'));
    els.speedHeading.textContent = t('playbackSpeed');
    els.reset.textContent = t('reset');
    els.reset.setAttribute('aria-label', t('resetLabel'));
    els.reset.title = t('resetLabel');
    els.minus.setAttribute('aria-label', t('decrease'));
    els.minus.title = t('decrease');
    els.plus.setAttribute('aria-label', t('increase'));
    els.plus.title = t('increase');
    els.input.setAttribute('aria-label', t('speedInput'));
    els.slider.setAttribute('aria-label', t('speedSlider'));
    els.presets.setAttribute('aria-label', t('presets'));
    for (const button of presetButtons) button.setAttribute('aria-label', t('presetLabel', { speed: `${button.dataset.speed}×` }));
    els.offValue.textContent = t('statusOff');
    els.savedLabel.textContent = t('savedSpeedWhenOn');
    els.reloadButton.setAttribute('aria-label', t('reloadTab'));
    els.reloadButton.title = t('reloadTab');
    els.showOverlayLabel.textContent = t('showOverlay');
    els.rememberLabel.textContent = t('rememberSpeed');
    els.languageLabel.textContent = t('language');
    els.authorText.textContent = t('authorLink');
    els.authorHint.textContent = t('opensNewTab');
    fillLanguageOptions();
    render();
  }

  /** 選択肢は一度だけ作り、以後は「自動」の文言だけ更新する（DOM を全置換しない）。 */
  function fillLanguageOptions() {
    const select = els.language;
    if (!select.options.length) {
      const auto = document.createElement('option');
      auto.value = 'auto';
      select.appendChild(auto);
      for (const [code, name] of I.LANGUAGES) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = name;
        option.lang = I.htmlLang(code);
        option.dir = I.dir(code);
        select.appendChild(option);
      }
    }
    select.options[0].textContent = t('languageAuto');
    if (!ui.languagePending) select.value = ui.languagePref;
  }

  /** 第4.2節の優先順位で案内を1つ選ぶ。 */
  function computeNotice() {
    if (ui.loadFailed) return { key: 'errLoadSettings', error: true };
    if (ui.saveError) return { key: 'errSaveSettings', error: true };
    if (ui.reloadError) return { key: 'errReload', error: true, reload: !!ui.tab && ui.tab.urlKind === 'web' };
    if (!displayEnabled() || ui.togglePending) return null;
    if (ui.inputError) return { key: 'errInput', error: true };
    if (!ui.ready) return null;
    if (!ui.tab) return { key: 'errNoTab', error: true };
    const state = ui.tabState;
    const hasReports = !!(state && state.connected);
    if (ui.tab.urlKind !== 'web' && !hasReports) return null;
    if (ui.reloadPending) return { key: 'msgReload', reload: true };
    if (!ui.stateKnown) return null;
    if (!hasReports) return ui.tab.urlKind === 'web' ? { key: 'msgReload', reload: true } : null;
    const result = ui.opResult;
    if (result && !result.delivered && result.applied === 0 && state.videoCount > 0) return { key: 'errCannotConfirm', error: true };
    if (state.videoCount === 0) return { key: 'msgNoVideo' };
    if (result && result.applied === 0) return { key: 'errCannotChange', error: true };
    return null;
  }

  function render() {
    const enabled = displayEnabled();
    const locked = controlsLocked();
    const state = ui.tabState;

    document.body.classList.toggle('loading', !ui.ready && !ui.loadFailed);

    // ヘッダー: 取得できた実速度だけを表示する
    const known = enabled && !ui.togglePending && ui.stateKnown && state && state.connected &&
      state.videoCount > 0 && state.speed != null;
    const statusText = !enabled ? t('statusOff')
      : known ? `${t('statusOn')} · ${S.formatFixed(state.speed)}×`
      : t('statusOn');
    if (els.statusText.textContent !== statusText) els.statusText.textContent = statusText;
    els.status.classList.toggle('off', !enabled);

    els.enabled.checked = !!enabled;
    els.enabled.disabled = !ui.ready || ui.loadFailed || ui.togglePending;

    // 速度カード
    els.onView.hidden = !enabled;
    els.offView.hidden = !!enabled;
    els.reset.hidden = !enabled;
    els.savedValue.textContent = `${S.formatFixed(ui.settings.speed)}×`;

    const value = ui.opValue;
    // 編集中の数値は状態報告・保存応答・言語変更で上書きしない
    if (!ui.dirty) els.input.value = S.formatFixed(value);
    els.input.disabled = locked;
    els.input.setAttribute('aria-invalid', String(ui.inputError));
    els.reset.disabled = locked;
    els.minus.disabled = locked || value <= S.MIN_SPEED + S.EPSILON;
    els.plus.disabled = locked || value >= S.MAX_SPEED - S.EPSILON;
    const clamped = S.clampSpeed(value);
    els.slider.value = String(clamped);
    els.slider.disabled = locked;
    els.slider.setAttribute('aria-valuetext', `${S.formatFixed(clamped)}×`);
    els.slider.style.setProperty('--progress', `${((clamped - S.MIN_SPEED) / (S.MAX_SPEED - S.MIN_SPEED)) * 100}%`);
    for (const button of presetButtons) {
      button.disabled = locked;
      button.setAttribute('aria-pressed', String(S.sameSpeed(value, Number(button.dataset.speed))));
    }

    // 設定
    for (const key of ['showOverlay', 'rememberSpeed']) {
      const input = els[key];
      input.checked = key in ui.optimistic ? ui.optimistic[key] : ui.settings[key];
      input.disabled = !ui.ready || ui.loadFailed || !enabled || ui.togglePending;
    }
    els.language.disabled = !ui.ready || ui.loadFailed;
    if (!ui.languagePending && els.language.value !== ui.languagePref) els.language.value = ui.languagePref;

    // 案内
    const notice = computeNotice();
    if (notice) {
      const text = t(notice.key);
      if (els.noticeText.textContent !== text) els.noticeText.textContent = text;
      els.notice.classList.toggle('error', !!notice.error);
      els.notice.setAttribute('aria-live', notice.error ? 'assertive' : 'polite');
      els.notice.hidden = false;
      els.reloadButton.hidden = !notice.reload;
      els.reloadButton.disabled = ui.reloadPending;
    } else {
      els.notice.hidden = true;
      els.noticeText.textContent = '';
      els.reloadButton.hidden = true;
    }
  }

  // -------------------------------------------------------------------------
  // イベント
  // -------------------------------------------------------------------------

  els.enabled.addEventListener('change', toggleEnabled);
  els.showOverlay.addEventListener('change', () => toggleSetting('showOverlay'));
  els.rememberSpeed.addEventListener('change', () => toggleSetting('rememberSpeed'));
  els.language.addEventListener('change', () => {
    finishPointer();
    changeLanguage();
  });
  els.language.addEventListener('blur', finishPointer);
  els.reset.addEventListener('click', () => requestSpeed(1));
  els.minus.addEventListener('click', () => requestSpeed(Math.max(S.MIN_SPEED, S.round2(ui.opValue - S.STEP))));
  els.plus.addEventListener('click', () => requestSpeed(Math.min(S.MAX_SPEED, S.round2(ui.opValue + S.STEP))));
  els.reloadButton.addEventListener('click', reloadTab);

  els.slider.addEventListener('input', () => {
    requestSpeed(S.round2(Number(els.slider.value)));
  });

  // 別コントロール押下中は blur 確定を pointerup 後まで遅らせ、案内表示の段ズレと誤確定を防ぐ
  let pointerDown = false;
  let pendingBlur = false;
  function finishPointer() {
    if (!pointerDown) return;
    pointerDown = false;
    setTimeout(() => {
      if (!pendingBlur) return;
      pendingBlur = false;
      if (document.activeElement !== els.input) commitInput();
    }, 0);
  }
  function commitOnBlur() {
    if (pointerDown) {
      pendingBlur = true;
      return;
    }
    commitInput();
  }
  document.addEventListener('pointerdown', (event) => {
    if (event.target === els.input) return;
    pointerDown = true;
  }, true);
  window.addEventListener('pointerup', finishPointer, true);
  window.addEventListener('pointercancel', finishPointer, true);
  window.addEventListener('blur', finishPointer);

  els.input.addEventListener('input', () => {
    ui.dirty = true;
  });
  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      commitInput();
    } else if (event.key === 'Escape' && ui.dirty) {
      event.preventDefault();
      ui.dirty = false;
      ui.inputError = false;
      render();
    }
  });
  els.input.addEventListener('change', commitOnBlur);
  els.input.addEventListener('blur', commitOnBlur);

  // 初期読込より先に変更を購読する
  let settingsVersion = 0;
  let languageVersion = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[KEYS.settings]) {
      settingsVersion += 1;
      const prevEnabled = ui.settings.enabled;
      // 他の画面からの変更も反映するが、操作値（opValue）は動かさない
      ui.settings = S.sanitizeSettings(changes[KEYS.settings].newValue);
      if (ui.ready && !ui.togglePending && prevEnabled !== ui.settings.enabled) {
        ui.tabState = null;
        ui.stateKnown = false;
        ui.opResult = null;
        ui.dirty = false;
        ui.inputError = false;
        ui.opValue = ui.settings.speed;
        if (ui.settings.enabled) setTimeout(refreshState, 120);
      }
      render();
    }
    if (changes[KEYS.language]) {
      languageVersion += 1;
      if (!ui.languagePending) {
        ui.languagePref = I.sanitizePreference(changes[KEYS.language].newValue);
        applyLanguage();
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== MSG.tabStateChanged || !ui.tab || msg.tabId !== ui.tab.id) return;
    // 速度指示・ON/OFF・再読込中の競合通知は採用しない
    if (!ui.ready || ui.speedPending || ui.togglePending || ui.reloadPending || !ui.settings.enabled) return;
    if (acceptState(msg.state, false)) render();
  });

  async function resolveTab() {
    // ?tabId= は自動テストでポップアップをタブとして開くときだけ使う
    const param = new URLSearchParams(location.search).get('tabId');
    try {
      let tab;
      if (param != null) {
        const id = Number(param);
        if (!Number.isInteger(id)) return null;
        tab = await chrome.tabs.get(id);
      } else {
        [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      }
      if (!tab || !Number.isInteger(tab.id) || tab.id < 0) return null;
      const url = tab.pendingUrl || tab.url;
      let urlKind = S.classifyUrl(url);
      // file:// は「ファイルの URL へのアクセスを許可」が無いと content script が動かず、再読み込みしても直らない
      if (urlKind === 'web' && /^file:/i.test(url)) {
        const allowed = await chrome.extension.isAllowedFileSchemeAccess().catch(() => false);
        if (!allowed) urlKind = 'internal';
      }
      return { id: tab.id, urlKind };
    } catch (_) {
      return null;
    }
  }

  async function init() {
    applyLanguage();
    const sv = settingsVersion;
    const lv = languageVersion;
    let stored;
    try {
      stored = await chrome.storage.local.get([KEYS.settings, KEYS.language]);
    } catch (_) {
      ui.loadFailed = true;
      render();
      return;
    }
    if (sv === settingsVersion) ui.settings = S.sanitizeSettings(stored[KEYS.settings]);
    if (lv === languageVersion) ui.languagePref = I.sanitizePreference(stored[KEYS.language]);
    ui.opValue = ui.settings.speed;
    ui.tab = await resolveTab();
    ui.ready = true;
    applyLanguage();
    if (ui.settings.enabled && ui.tab) refreshState();
  }

  init();
})();
