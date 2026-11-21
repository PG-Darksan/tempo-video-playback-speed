# 動画再生速度変更（Tempo）

Web ページの動画の再生速度を 0.25〜16 倍に変える、Chrome / Microsoft Edge 用の拡張機能です。
ツールバーのボタンと、動画の左上に出る小さなパネルの両方から操作できます。

- バージョン: 1.5.4（Manifest V3、Chrome / Edge 119 以降・Firefox 140 以降）
- 対応言語: 日本語・English・한국어・简体中文・繁體中文・Español・Français・Deutsch・Português (Brasil)・Русский・हिन्दी・العربية
- 作者: <https://hisator-notebook.com>

## 導入

### ストアから
Chrome ウェブストア / Edge アドオン / Firefox Add-ons で公開後は、ストアのページから追加します。

### ZIP から（パッケージ化されていない拡張機能として）
1. `Tempo-Chrome-Edge.zip` を展開します。中に `Tempo` フォルダーがあります。
2. Chrome は `chrome://extensions`、Edge は `edge://extensions` を開きます。
3. 「デベロッパー モード」をオンにします。
4. 「パッケージ化されていない拡張機能を読み込む」（Edge は「展開して読み込み」）を押し、`Tempo` フォルダーを選びます。
5. ツールバーのパズルのアイコンから「動画再生速度変更」をピン留めすると使いやすくなります。

導入前から開いていたタブでは動きません。そのタブを再読み込みしてください（ポップアップにも案内とボタンが出ます）。

### パソコン内の動画ファイル（file://）で使う
Chrome / Edge では拡張機能の「詳細」を開き、「ファイルの URL へのアクセスを許可する」をオンにします。Firefox（153 以降）では `about:addons` の権限設定でローカルファイルへのアクセスを許可します。

## 更新
- ストア版は自動で更新されます。
- ZIP 版は、新しい ZIP を同じ場所に展開して上書きし、拡張機能の管理画面で再読み込み（↻）を押します。開いていたタブは再読み込みしてください。

## 使い方

### ツールバーのポップアップ（今のタブの全動画が対象）
- 中央の数値: 0.25〜16 を 0.01 単位で入力し、Enter（または欄の外を押す）で確定します。
- −／＋: 0.25 ずつ増減します。スライダーは 0.05 刻みです。
- 1×・2×・4×・8×・16×: よく使う速度です。「リセット」で 1 倍に戻ります。
- 右上のスイッチ: 拡張機能の ON/OFF。OFF にすると、拡張機能が変えた動画は元の速度に戻ります（サイト側で変えた速度はそのまま）。
- 動画上に表示: 動画の左上のパネルを出すかどうか。
- 速度を記憶: オンにすると、新しく見つけた動画や読み込み直した動画に、最後に選んだ速度を自動で適用します。
- 言語: 「自動（ブラウザー）」または 12 言語から選べます。

ツールバーのバッジには、そのタブの動画の実際の速度が出ます（OFF・動画なしでは空）。

### 動画上のパネル（その動画だけが対象）
- −／速度（押すと 1 倍）／＋ ／ ▾（詳細）／ 折りたたみ。
- 詳細では数値入力・スライダー・プリセットが使えます。
- 折りたたむと小さく淡いアイコンになります。押すと元に戻ります。キーボード（Tab・Enter・Space）でも操作できます。
- 幅 185px・高さ 88px 未満の小さな動画や画面外の動画にはパネルを出しません（ポップアップからは操作できます）。
- Google Meet や Zoom などのリアルタイム双方向通信（WebRTC / `MediaStream`）、未読込の空の `video` 要素、再生速度を変更できない動画にはパネルを出しません。

## 権限と個人情報
- `storage`: 設定（ON/OFF、速度、表示、記憶、言語）をこのブラウザー内に保存します。
- `activeTab`: ポップアップを開いたタブの状態確認と、そのタブだけの再読み込みに使います。
- すべての http/https/file ページへの content script: ページ内（埋め込みフレームを含む）の `video` 要素を見つけて速度を変えるためです。

URL・閲覧履歴・動画の状態は保存も外部送信もしません。アカウント、サーバー、アクセス解析、外部ライブラリーは使いません。

## 制限
- ブラウザーの内部ページ（`chrome://` `edge://` `about:`）、拡張機能ストアのページでは動きません。
- Google Meet・Zoom・Teams・Discord 通話などのリアルタイム双方向通信（`MediaStream`）は再生速度を変更できないため制御対象外です。
- 閉じた Shadow DOM の中の動画、独自方式の特殊なプレーヤーは操作できないことがあります。
- サイトが速度変更を拒否・上書きする場合は動画上パネルを隠し、ポップアップで「再生速度を変更できません。」と表示します。
- 既存の要素に後から `attachShadow()` だけで追加された動画は、ポップアップを開いた時（状態照会・速度指示の時）に見つけます。
- 音声だけの `audio` 要素は対象外です。

## 開発者向け
構成・通信・状態遷移は [IMPLEMENTATION.md](IMPLEMENTATION.md)、検証結果は [TESTING.md](TESTING.md)、
仕様は [SPECIFICATION.md](SPECIFICATION.md)、ストア申請は [store/README.md](store/README.md) を見てください。

| 目的 | コマンド（このフォルダーで実行） |
| --- | --- |
| 翻訳カタログの生成 | `node scripts/build-i18n.cjs` |
| 翻訳カタログの検査 | `node scripts/build-i18n.cjs --check` |
| アイコンの再生成 | `powershell -ExecutionPolicy Bypass -File scripts/generate-icons.ps1` |
| Chrome / Edge 提出用 ZIP（クロスプラットフォーム） | `node scripts/pack-chromium.cjs` |
| Chrome / Edge 提出用 ZIP（Windows PowerShell） | `powershell -ExecutionPolicy Bypass -File scripts/package.ps1` |
| Firefox 提出用 ZIP | `node scripts/pack-firefox.cjs` |
| テスト | [tests/README.md](tests/README.md) を参照 |
