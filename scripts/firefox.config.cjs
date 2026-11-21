'use strict';
// pack-firefox.cjs の設定 (Tempo – 動画再生速度変更)
const RUNTIME = ['manifest.json', 'background.js', 'content.js', 'shared.js', 'i18n.js', 'popup.html', 'popup.css', 'popup.js'];

module.exports = {
  source: '.',
  folderName: 'Tempo-firefox',
  zipName: 'Tempo',
  geckoId: 'tempo@hisator-notebook.com',
  // service worker の importScripts('shared.js', 'i18n.js') と同じ順
  backgroundScripts: ['shared.js', 'i18n.js', 'background.js'],
  include: (rel) => RUNTIME.includes(rel) || /^_locales\/[A-Za-z_]+\/messages\.json$/.test(rel) || /^icons\/icon(16|32|48|128)\.png$/.test(rel),
  patches: [
    // イベントページには importScripts が無い (manifest の background.scripts で先に読み込む)
    { file: 'background.js', find: "importScripts('shared.js', 'i18n.js');", replace: "if (typeof importScripts === 'function') importScripts('shared.js', 'i18n.js');" },
    // Firefox で拡張機能が動かないストア・アカウント画面
    {
      file: 'shared.js',
      find: '/^https:\\/\\/microsoftedge\\.microsoft\\.com\\/addons/i',
      replace: [
        '/^https:\\/\\/microsoftedge\\.microsoft\\.com\\/addons/i,',
        '    /^https:\\/\\/(discovery\\.)?addons\\.mozilla\\.org\\//i,',
        '    /^https:\\/\\/([a-z0-9-]+\\.)?accounts\\.firefox\\.com\\//i,',
        '    /^https:\\/\\/support\\.mozilla\\.org\\//i'
      ].join('\n')
    }
  ]
};
