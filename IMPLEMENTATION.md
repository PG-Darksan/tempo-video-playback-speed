# 実装の説明

仕様（[SPECIFICATION.md](SPECIFICATION.md)）をどう実装したかの説明です。
実行時は HTML / CSS / JavaScript だけで動き、コンパイル・外部ライブラリー・サーバーは使いません。

## 構成

| ファイル | 役割 |
| --- | --- |
| `manifest.json` | Manifest V3。権限は `storage` `activeTab` のみ。content script は http / https / file、`all_frames` `match_about_blank` `match_origin_as_fallback`、`document_idle` |
| `shared.js` | 全コンテキスト共通: 定数、メッセージ名、設定の検証（`sanitizeSettings`）、入力の解析、数値の整形、URL の分類 |
| `i18n.js` | 全コンテキスト共通: 12 言語の組み込みカタログ（生成）、自動言語の解決、`t()`、`dir()` |
| `background.js` | Service Worker: 設定保存の単一キュー、フレーム報告の集約、タブ別バッジ |
| `content.js` | フレームごと: 動画の検出と後処理、所有権、動画上パネル、上り報告 |
| `popup.html` `popup.css` `popup.js` | ポップアップ: 保存速度と実速度を分けた表示、案内の優先順位 |
| `_locales/<12言語>/messages.json` | 翻訳の原本。manifest の名前・説明もここから |
| `scripts/build-i18n.cjs` | `_locales` → `i18n.js` の生成と整合チェック（`--check`） |
| `scripts/generate-icons.ps1` | アイコン 16/32/48/128px の再生成 |
| `scripts/package.ps1` | `dist/Tempo/`、`Tempo-Chrome-Edge.zip`、ストア用 `Tempo-webstore.zip` |

## 保存データ

`chrome.storage.local` に次の 2 キーだけを保存します（仕様 7 章と同じ形）。

```json
{ "tempoSettings": { "version": 1, "enabled": true, "speed": 1, "showOverlay": true, "rememberSpeed": true },
  "tempoLanguage": "auto" }
```

- 読むときは必ず `sanitizeSettings` を通します。boolean 以外は初期値、speed は有限数のみ 0.25〜16 に丸めて小数 2 桁、不正値は 1。言語は `auto` か 12 コード以外なら `auto`。
- `onInstalled`（新規・更新）で正規化して書き戻します。`version` が 1 でない旧データもここで移行されます。
- 基準速度、動画リスト、URL、折りたたみ、詳細開閉、編集中の入力は保存しません（メモリーだけ）。

## 設定の保存（F08, F21）

popup と content は `TEMPO_SAVE_SETTINGS { patch }` を worker に送ります。worker は 1 本の Promise チェーンで直列化し、
**保存の直前に storage を読み直して許可項目だけをマージ**します。速度と表示設定を同時に変えても両方残ります。
動画上パネル（content script）から送れるのは `speed` だけです。

各コンテキストは `storage.onChanged` で変更を受け取ります。購読は初期読込より先に始め、変更の版番号で古い読込結果を捨てます。

| 受け取った変更 | content script の動作 |
| --- | --- |
| enabled: ON→OFF | 所有中の動画だけ基準速度へ戻し、全パネルを即座に隠す |
| enabled: OFF→ON | 記憶設定に関係なく、検出済みの全動画へ保存速度を適用 |
| showOverlay | パネルの表示だけを即座に切り替える |
| speed / rememberSpeed | 既存動画は変えない。以後の新規検出・`loadedmetadata` で使う |
| language | 既存パネルの文言・方向を更新（DOM は作り直さない） |

## 速度の所有権（仕様 3 章）

動画ごとに `baselineRate` と `appliedRate` をメモリーで持ちます。

- 適用前に「未所有」または「実速度が最終適用値と違う」なら、`baselineRate` を今の実速度にします。連続して 4→8 倍にしても基準は最初の値のまま。
- `ratechange` で実速度が最終適用値と違えば、サイトや利用者の操作とみなし、その値を新基準にして所有を解除します。
- OFF では「最終適用値があり、実速度との差が 0.001 未満」の動画だけ基準速度へ戻し、所有を解除します。setter が例外を投げても続行します。
- サイトが `ratechange` の中で速度を戻す場合に備え、自分の変更による `ratechange` が配送され終わるのを待ってから実速度を確かめます（`whenRateSettled`）。

## 通信

| メッセージ | 方向 | 内容 |
| --- | --- | --- |
| `TEMPO_GET_TAB_STATE` | popup → worker | タブの全フレームへ `TEMPO_REQUEST_REPORT` を送り、集約状態を返す |
| `TEMPO_SET_TAB_SPEED` | popup → worker | 全フレームへ `TEMPO_SET_SPEED` を送り、実報告から `applied` / `failed` を返す |
| `TEMPO_SET_SPEED` / `TEMPO_REQUEST_REPORT` | worker → 全フレーム | `requestId` 付き。content はすぐ `{ok:true}` を返し、実状態は別途上り報告 |
| `TEMPO_REPORT_STATE` | content → worker | 動画数、代表実速度、各実速度、再生中、画面内、`startedAt`（文書の開始）、`observedAt` |
| `TEMPO_GET_STATE` | worker → 特定フレーム | タブ切替時の生存確認 |
| `TEMPO_TAB_STATE_CHANGED` | worker → popup | 実報告の変化を 25ms でまとめて通知 |

### フレーム報告の集約（`collect`）

1. `chrome.tabs.sendMessage` で全フレームへ送ります。1 つ目の応答だけでは結論を出しません。
2. 上り報告を `frameId` ごとに集めます。早期終了は「送信の成否が分かり、動画のあるフレームがすべてこの `requestId` に答え、既知の動画フレームも揃った」後、60ms の静穏期間で行います。締切は 400ms。
3. 締切までに `requestId` への報告が無く、送信が成功または未確定なら、一度だけ 1.1 秒延長します（混雑したページで無報告と誤判定しないため）。
4. 送信失敗かつ報告なし → すぐ終了（content script が無い = 通信なし）。
5. 新旧の判定（`isNewer`）: 送信元が今の文書（`documentLifecycle` が `active`）でない報告は受け取りません（事前レンダリング中・bfcache・削除待ち）。同じ文書なら `observedAt`、文書が替われば到着順で採用します（戻る／進むで復元した文書も扱えるよう、`startedAt` の大小では決めない）。documentId の無い生存確認の応答だけ `startedAt` で比べます。
6. トップフレームの文書が替わった・消えた（`pagehide` の消滅報告）・タブの読み込みが完了したときは、古いページのサブフレームを捨て、250ms 後に実フレームへ照会し直してキャッシュ・バッジ・ポップアップを更新します。去った文書の消滅報告は、その文書の記録だけを消します。

### 速度指示（`setTabSpeed`）

1. `TEMPO_SET_SPEED` で集約します。送信の成否が締切で分からなければ 1.2 秒まで待ちます。
2. 届かなかった、または目標速度の動画が 0 個なら、**状態照会だけ**を 1 回行います（速度指示は再送しない）。応答だけを失った成功はここで確認できます。
3. `applied` = 目標との差が 0.001 未満の動画数、`failed` = 報告された動画数との差。

### 集約状態

`{ ok, connected, enabled, videoCount, speed, frames[], updatedAt }`。`connected` は新鮮な実報告があるかどうかで、動画数とは別です。
代表速度はフレーム内で「再生中 → 最後に操作 → 画面内 → 先頭」、フレーム間で「再生中 → 画面内 → トップフレーム」。
`updatedAt` は worker 内で単調増加します。worker が再起動しても、次の照会や content の上り報告で実フレームから作り直します。

## ポップアップ

- 表示する数値は、取得後は代表動画の実速度、取得前は保存速度（操作値）。ヘッダーとバッジは**取得できた実速度だけ**。
- 操作番号 `seq` を速度指示・照会・ON/OFF・再読込のたびに増やし、古い応答を捨てます。通知は `updatedAt` が新しいものだけ採用し、速度指示・ON/OFF・再読込の処理中は採用しません。
- 入力欄は編集中（`dirty`）なら状態報告・保存応答・言語変更で上書きしません。Enter・change・blur で確定し、確定後は `dirty` を解くので Enter 後の blur で二重に送りません。
- 速度指示と保存は同時に別々に送ります。片方が失敗してももう片方の結果は残ります。
- 保存に失敗したスイッチ・言語は保存済みの値に戻し、「設定を保存できませんでした。」を出します（動画の通知では消しません）。

### 案内の優先順位（仕様 4.2）

`computeNotice()` が上から最初に当てはまるものを返します。

1. 設定読込の失敗 / 保存の失敗 / 再読み込みの失敗（再試行ボタンは通常ページのみ）
2. OFF → 何も出さない
3. 入力不正（`aria-invalid`）
4. タブはあるが URL が http/https/file 以外または取得できず、実報告も無い → 何も出さない
5. タブが無い / 通常ページで報告なし（再読み込みボタン） / 通信失敗後に目標速度を確認できない
6. 接続済みで動画 0 個
7. 動画はあるが目標速度の動画が 0 個（変更拒否。play/pause では消さず、目標速度の観測・動画の消失・次の操作で解消）

URL は `pendingUrl` を優先し、判定にだけ使います。ツールバーのボタンで開くと `activeTab` により URL が分かります。
拡張機能を動かせないストアのページ（chromewebstore.google.com、chrome.google.com/webstore、microsoftedge.microsoft.com/addons）と、
「ファイルの URL へのアクセスを許可」が無い `file://`（`chrome.extension.isAllowedFileSchemeAccess()` で確認）は内部ページと同じ扱いにし、直らない再読み込み案内を出しません。

速度指示の途中は状態照会を始めません（速度指示の応答が最新の実状態を運ぶため）。操作値（−／＋の基準）は常に実速度へ合わせ、入力欄の文字だけを編集中は残します。

## 動画上パネル

- 独自要素 `<tempo-speed-panel>` に open Shadow DOM を付け、共有の `CSSStyleSheet` を `adoptedStyleSheets` で使います（使えない環境では `<style>`）。DOM は `createElement` で組み立て、`innerHTML` は使いません。
- ホストは `position: fixed`、最大の `z-index`、`pointer-events: none`。中のパネルだけ `auto`。click / dblclick / pointer / mouse / touch / key 系のイベントはパネルで伝播を止めます。
- open Shadow DOM なのでページのスクリプトからも要素に触れられます。操作は `event.isTrusted` のもの（利用者の操作）だけを受け付け、ページが共通の保存速度を書き換えられないようにしています。
- 位置は動画の左上から右 10px・下 10px、画面端 8px に収まるよう補正。`requestAnimationFrame` とスクロール・リサイズ・`ResizeObserver`、表示中は 800ms ごとに追従します。
- 表示条件: 有効・表示設定 ON・画面内・幅 185px 以上・高さ 88px 以上・不可視でない。条件を満たさなくても検出済みならポップアップの操作対象です。
- コンテナーの全画面ではその要素の中へ移し（その要素が Shadow host なら Shadow root の中へ）、`video` 自体の全画面では隠します。
- 状態（基本列・詳細・折りたたみ）は動画ごとにメモリーで保持し、隠れても維持します。折りたたむと復帰ボタン、戻すと折りたたみボタンへフォーカスを移します。
- 復帰ボタンは 26×26px＋枠 1px＝外寸 28×28px、12px の線画（仕様の SVG そのまま）。通常は背景 24%・線 65%・影なし、ホバーと `:focus-visible` だけ強めます。

## 動画の検出と後処理（F24）

- 初期走査: `querySelectorAll('video')` と、open Shadow DOM を TreeWalker でたどります。自分のパネルは除外します。
- 監視: document と見つけた各 shadow root を `MutationObserver` で監視。追加ノードは部分走査、削除は 80ms 後に確認して後処理（移動なら残す）。文書から外れた shadow root の監視も外します。
- 後処理: メディアイベントの購読（`AbortController`）、`ResizeObserver`、パネルのホストを破棄します。別の文書へ移った動画（Document Picture-in-Picture など）も登録を外します。
- 外した動画の基準速度と最終適用値は `WeakMap` に残し、付け直されて実速度がまだ拡張機能の値なら所有権を引き継ぎます。外れている間に OFF になっていれば、付け直した時に元の速度へ戻します。
- 拡張機能の更新・無効化で文脈が失われたら（動画の登録・`loadedmetadata`・DOM 監視・定期処理・送信失敗の各入口で確認）、古い設定を当てずにパネル・監視・タイマーをすべて片付けます。
- 事前レンダリングで開かれたページは、表示された時（`prerenderingchange`）に報告し直します。
- 二重初期化はフレームごとのフラグで防ぎます。
- **制約**: 既存の要素に後から `attachShadow()` だけを行ったケースは `MutationObserver` に現れないため、自動では検出しません。ポップアップの状態照会・速度指示のたびに全体を再走査するので、そこで検出します（テスト `F24 open Shadow DOM` で確認）。

## 多言語

- 原本は `_locales/<言語>/messages.json`。`node scripts/build-i18n.cjs` が `i18n.js` の生成範囲へ埋め込みます。`--check` はキー集合・空文字・キー名そのままの訳・プレースホルダー・manifest の参照・文字数を検査します。
- 自動設定は `chrome.i18n.getUILanguage()` を解決します（zh の TW/HK/MO/Hant → 繁体、その他 zh → 簡体、pt → pt_BR、未対応 → en）。
- アラビア語は RTL。ポップアップの中央の数値・スライダー・範囲・プリセット・OFF 時の保存倍率は `dir="ltr"` で固定。動画上パネルは言語の方向に従い、数値だけ LTR に隔離します。
- 管理画面の名前は manifest のローカライズ（ブラウザーの言語）で、アプリ内の手動言語とは別です。

## テスト専用の入口

`popup.html?tabId=<数値>` は、自動テストでポップアップをタブとして開くときに対象タブを指定するためのものです。通常のポップアップには付きません。
指定されたタブの URL は `activeTab` が無いと読めないため、権限の範囲は変わりません。
