// テストページ共通: 動画を末尾で巻き戻して再生を続ける
document.addEventListener('ended', (event) => {
  const v = event.target;
  if (v && v.localName === 'video') {
    v.currentTime = 0;
    v.play().catch(() => {});
  }
}, true);

window.T = {
  videos: () => [...document.querySelectorAll('video')],
  makeVideo(src = '/media/bright.webm', cls = '') {
    const v = document.createElement('video');
    v.src = src;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    if (cls) v.className = cls;
    return v;
  }
};
