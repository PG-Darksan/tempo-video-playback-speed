# 実ブラウザーテスト

利用中のプロフィールとは別の一時プロフィールへ実際の拡張機能を読み込み、ローカル HTTP の実動画を操作します。
ポップアップの表示だけでなく、`video.playbackRate`・`chrome.storage.local`・タブ別バッジを照合します。

## 準備（初回だけ、このフォルダーで）

```
npm.cmd ci
npx.cmd playwright install chromium
```

Edge のテストには Microsoft Edge（安定版）のインストールが必要です。

## 実行（このフォルダーで、順番に）

```
npm.cmd test                    # 基本動作・通信・表示判定（Chromium）
npm.cmd run test:edge           # 同（Edge）
npm.cmd run test:i18n           # 12言語・RTL・画面サイズ（Chromium）
npm.cmd run test:i18n:edge
npm.cmd run test:settings       # 設定・保存・自動適用（Chromium）
npm.cmd run test:settings:edge
npm.cmd run test:folded         # 動画上パネルの折りたたみ（Chromium）
npm.cmd run test:folded:edge
npm.cmd run test:package        # 配布 ZIP（scripts/package.ps1 を実行して展開・読込）
npm.cmd run test:package:edge
```

インストール済みの Google Chrome（正式版）でも同じテストを実行できます。正式版は `--load-extension` を受け付けないため、起動直後に CDP の `Extensions.loadUnpacked` で読み込みます。

```
npm.cmd run test:chrome
npm.cmd run test:i18n:chrome
npm.cmd run test:settings:chrome
npm.cmd run test:folded:chrome
npm.cmd run test:package:chrome
```

ストア掲載用の画像（`../store/images/`）は `npm.cmd run store:assets` で作り直せます。

画面を見ながら実行するときは `set HEADED=1` を先に実行します。

## 仕組み

| ファイル | 内容 |
| --- | --- |
| `helpers.cjs` | ローカルサーバー2つ（`127.0.0.1` と `localhost` = 別オリジン・別サイト）、拡張機能の読込、ポップアップ・Service Worker・バッジの操作 |
| `core.spec.cjs` | A01〜A11, A16, A17, A25〜A30, A33, A34 |
| `settings.spec.cjs` | A12〜A15, A31, A32, open Shadow DOM |
| `folded.spec.cjs` | A18〜A21（画像を `results/screens/` に保存） |
| `i18n.spec.cjs` | A22〜A24（全言語の画面を `results/screens/` に保存） |
| `package.spec.cjs` | A35 と、外部送信・遠隔コードの静的確認 |
| `fixtures/site/` | テスト用ページ（2動画、別オリジン iframe、Shadow DOM、速度を拒否するサイト、全画面など） |
| `fixtures/media/` | テスト用動画（明るい・暗い、各8秒）。`npm.cmd run make:fixture` で作り直せます |

- ポップアップは `popup.html?tabId=<タブID>` としてタブで開きます（テスト専用の指定。通常の利用では使いません）。
- ツールバーのボタン操作は CDP の `Extensions.triggerAction` で再現し、実際の `activeTab` 権限を付けます。
- 「拡張機能の導入前から開いていたページ」は、ページを開いてから CDP の `Extensions.loadUnpacked` で導入して再現します。
- Service Worker の再起動は CDP の `ServiceWorker.stopAllWorkers` で再現します。
- 結果は `results/<対象>-<ブラウザー>.json` に残ります。
