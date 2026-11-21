# プライバシーポリシー — 動画再生速度変更（Tempo）

制定日: 2026年10月23日

「動画再生速度変更」（英語名 Tempo – Video Playback Speed、以下「本拡張機能」）は、Web ページの動画の再生速度を変えるためのブラウザー拡張機能です。

## 集める情報
本拡張機能は、利用者の個人情報・閲覧履歴・閲覧したページの URL・動画の内容や視聴状況を収集しません。

## 保存する情報
次の設定だけを、利用者のブラウザー内（`chrome.storage.local`）に保存します。外部のサーバーには送りません。

- 拡張機能の ON / OFF
- 最後に選んだ再生速度
- 「動画上に表示」「速度を記憶」の設定
- 表示言語

設定は、拡張機能を削除すると一緒に消えます。

## 外部への送信
本拡張機能は、どのような情報も外部へ送信しません。サーバー、アカウント、広告、アクセス解析、外部のライブラリーやプログラムは使用していません。

## 権限の使い道
- `storage`: 上記の設定をブラウザー内に保存するため。
- `activeTab`: ツールバーのボタンを押したタブについて、再読み込みが必要かどうかを判断し、利用者が求めたときにそのタブだけを再読み込みするため。URL は判断に使うだけで、保存も送信もしません。
- Web ページ（http / https / file）への content script: ページ内の動画（`video` 要素）を見つけて再生速度を変え、動画の上に操作パネルを表示するため。ページの内容を読み取って保存・送信することはありません。

## 変更
本ポリシーを変更する場合は、このページで告知します。

## お問い合わせ
https://hisator-notebook.com

---

# Privacy Policy — Tempo – Video Playback Speed

Effective: October 23, 2026

Tempo – Video Playback Speed ("the extension") is a browser extension that changes the playback speed of videos on web pages.

## Information we collect
The extension does not collect any personal information, browsing history, URLs of pages you visit, or the content or viewing status of videos.

## Information stored on your device
Only the following settings are stored in your browser (`chrome.storage.local`). They are never sent to any server.

- Whether the extension is ON or OFF
- The last playback speed you chose
- The "Show on videos" and "Remember speed" settings
- The display language

The settings are removed when you uninstall the extension.

## Data sharing
The extension does not send any information anywhere. It uses no servers, accounts, ads, analytics, or remote libraries or code.

## How permissions are used
- `storage`: to keep the settings above in your browser.
- `activeTab`: for the tab where you click the toolbar button, to tell whether the page needs to be reloaded and to reload only that tab when you ask. The URL is only used for this check and is never stored or sent.
- Content scripts on web pages (http / https / file): to find videos (`video` elements) on the page, change their speed, and show the control panel on top of them. Page content is never read for storage or transmission.

## Changes
Any changes to this policy will be announced on this page.

## Contact
https://hisator-notebook.com
