// Death: the death camera plays clean for a beat (plus FLOW.deathDelay of
// sinking before this screen), then 「鱼没吃上。」 rises out of a dark-red veil
// that still lets the scene through, then 「再来一次」 (Enter).
import { h, replay, reloadWith, charSpans } from '../dom.js';
import { Menu } from '../Menu.js';
import { WAVES } from '../../core/config.js';

// Lines that drift in under the title, picked per death (restrained, in-world).
const EPITAPHS = [
  '晚饭还没着落。',
  '老婆还在等你回家。',
  '锅都准备好了。',
  '再下去找找。',
];

export class DeathScreen {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this._count = 0;
    const el = (this.el = h('section', 'fish-screen fish-death'));
    el.innerHTML = `
      <div class="fish-death__bg"></div>
      <div class="fish-death__inner">
        <h2 class="fish-death__title" aria-label="鱼没吃上。">${charSpans('鱼没吃上。')}</h2>
        <div class="fish-death__rule"></div>
        <div class="fish-death__sub"></div>
        <nav class="fish-death__menu">
          <button class="fish-btn fish-btn--primary" data-act="retry">再来一次</button>
          <button class="fish-btn fish-btn--small" data-act="title">回到标题</button>
        </nav>
        <div class="fish-hint fish-death__hint"><kbd>Enter</kbd> 再来一次</div>
      </div>`;
    this.subEl = el.querySelector('.fish-death__sub');

    // Armed only once the buttons have faded in (see .fish-death CSS delays).
    this.menu = new Menu(this.game, { armDelay: 2.5 });
    this.menu.add(el.querySelector('[data-act="retry"]'), () => this.ui.retry());
    this.menu.add(el.querySelector('[data-act="title"]'), () => reloadWith({ autostart: null, wave: null }));
  }

  show() {
    const wave = WAVES[this.game.director?.waveIndex ?? 0];
    const epitaph = EPITAPHS[this._count++ % EPITAPHS.length];
    this.subEl.textContent = wave ? `${wave.title} · ${wave.subtitle}　—　${epitaph}` : epitaph;
    this.el.classList.add('is-on');
    replay(this.el);
    this.menu.open(0);
  }

  hide() {
    this.el.classList.remove('is-on');
    this.menu.close();
  }

  update(rdt) {
    this.menu.update(rdt);
  }
}
