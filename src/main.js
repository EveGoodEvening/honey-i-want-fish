import { Game } from './core/Game.js';

// Boot failures (no WebGL2, a module constructor throwing) would otherwise leave
// the splash saying "下水中…" forever; say so on it and log the cause.
function bootFailed(err) {
  console.error('[boot] failed', err);
  const sub = document.querySelector('#boot-splash .bs-sub');
  if (!sub) return;
  sub.textContent = /webgl/i.test(String(err?.message ?? err)) ? '这个浏览器无法创建 WebGL 2 画面。' : '启动失败，详见控制台。';
  sub.classList.add('is-error');
}

try {
  const game = new Game(document.getElementById('app'));
  game.init().catch(bootFailed); // async: staged construction behind the splash
} catch (err) {
  bootFailed(err);
}
