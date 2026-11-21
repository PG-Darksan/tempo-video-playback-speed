# Chrome ウェブストアへの申請手順

このフォルダーの資料と `dist/` の ZIP を使って申請します。入力欄にはそのまま貼れる文を用意しています。

| 用意するもの | 場所 |
| --- | --- |
| アップロードする ZIP（直下に manifest.json） | `dist/Tempo-webstore.zip` |
| ストア用アイコン 128×128 | `icons/icon128.png` |
| スクリーンショット 1280×800（日本語・英語 各3枚） | `store/images/screenshot-ja-*.png` `screenshot-en-*.png` |
| 小さいプロモーション タイル 440×280 | `store/images/promo-small-440x280.png` |
| 説明文 | `store/listing-ja.md` `store/listing-en.md` |
| プライバシーポリシー（Web に公開して URL を入れる） | `store/privacy-policy.md` |

## 1. ZIP を作る
このフォルダーの一つ上（プロジェクトのルート）で:

```
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
```

`dist/Tempo-webstore.zip` を使います。`dist/Tempo-Chrome-Edge.zip` は中に `Tempo` フォルダーがある配布用で、ストアには使えません。
画像を作り直すときは `tests` フォルダーで `npm.cmd run store:assets` を実行します。

## 2. 開発者登録（初回だけ）
1. <https://chrome.google.com/webstore/devconsole> を Google アカウントで開きます。
2. 登録料 5 米ドル（1回だけ）を払います。
3. アカウントの 2 段階認証をオンにし、連絡先メールを確認します。
4. 「販売者（Trader）」か「非販売者（Non-trader）」かを申告します（EU の規則）。販売者を選ぶと住所・電話番号がストアに表示されます。どちらにするかはご自身で判断してください。

## 3. プライバシーポリシーを公開する
共通プライバシーポリシーページ `https://hisator-notebook.com/extensions-privacy.html` に公開済みです。Chrome ウェブストアの「アカウント」→「プライバシーポリシーの URL」欄（および Microsoft Edge アドオンの申請欄）にこの URL を入力します。

## 4. アイテムを作る
ダッシュボードで「新しいアイテム」→ `dist/Tempo-webstore.zip` をアップロードします。

### ストアの掲載情報
| 欄 | 入れるもの |
| --- | --- |
| 説明 | `store/listing-ja.md` の「詳しい説明」 |
| カテゴリ | 例: ツール（Tools） |
| 言語 | 日本語（英語の掲載情報も追加するときは言語を切り替えて `listing-en.md`） |
| ストアアイコン | `icons/icon128.png` |
| スクリーンショット | `store/images/screenshot-ja-1〜3.png`（英語版は `screenshot-en-*`） |
| 小さいプロモーション タイル | `store/images/promo-small-440x280.png` |
| 公式 URL / ホームページ | `https://hisator-notebook.com` |
| サポート URL | 作者サイトの問い合わせページなど |

名前と短い説明は manifest（`_locales`）から自動で入ります。12 言語分あります。

### プライバシーへの取り組み
**単一用途の説明**

> Web ページ上の動画（HTML の video 要素）の再生速度を変更します。ツールバーのポップアップと、動画の上に重ねる小さな操作パネルから操作できます。
>
> Changes the playback speed of videos (HTML video elements) on web pages, from the toolbar popup or a small control panel shown on top of the video.

**権限が必要な理由**

| 権限 | 理由（日本語 / English） |
| --- | --- |
| `storage` | ON/OFF、再生速度、「動画上に表示」「速度を記憶」、表示言語の設定をブラウザー内に保存するため。 / To save the settings (on/off, speed, overlay, remember speed, language) locally in the browser. |
| `activeTab` | ツールバーのボタンを押したタブが通常のページかどうかを判断し、利用者が求めたときにそのタブだけを再読み込みするため。 / To check whether the tab where the user clicked the toolbar button is a normal web page, and to reload only that tab when the user asks. |
| ホスト権限（content script の http / https / file・全フレーム） | 利用者が開いたページと、その中に埋め込まれたフレームの video 要素を見つけて再生速度を変え、動画の上に操作パネルを表示するため。ページの内容を読み取って保存・送信することはありません。 / To find video elements on the pages the user opens (including embedded frames), change their playback speed and show the control panel on top of them. No page content is stored or transmitted. |

**リモートコード**: 「いいえ、リモートコードを使用していません」/ No, I am not using remote code.
（すべての JavaScript は ZIP に含まれています。外部のスクリプトや eval は使っていません。）

**データの使用**: 収集するデータの項目は**どれにもチェックしない**。下の 3 つの宣誓にはチェックします。

**プライバシーポリシー**: 手順 3 で公開した URL。

### 配布
- 公開範囲: 「公開」または、まず試すなら「限定公開」（URL を知っている人だけ）。
- 地域: すべての地域（必要に応じて絞る）。

### テストの手順（審査担当向け・任意）
> No account or setup is needed. Open any web page with an HTML5 video, click the toolbar button and choose a speed (for example 2×). A small panel also appears at the top-left of the video. Turn the extension OFF with the switch to restore the original speed.

## 5. 審査に出す
「審査のため送信」を押します。全ページで動く content script があるため、詳しい審査になり、通常より時間がかかることがあります（数日〜数週間）。不承認の場合は理由がメールで届くので、直して `manifest.json` の `version` を上げ、もう一度 ZIP を作って出します。

## 6. 更新するとき
1. `manifest.json` の `version` を上げる（例: 1.5.3 → 1.5.4）。前と同じ番号は受け付けられません。
2. `powershell -ExecutionPolicy Bypass -File scripts/package.ps1`
3. ダッシュボードの「パッケージ」で新しい `Tempo-webstore.zip` をアップロードし、審査に出す。

## Microsoft Edge アドオン
<https://partner.microsoft.com/dashboard/microsoftedge> で開発者登録（無料）し、同じ `Tempo-webstore.zip` を新しい拡張機能として申請します。説明文・画像・プライバシーポリシー・権限の理由は上と同じものを使えます。
