// Pause menu: 继续 / 重新开始本关 / 操作说明 / 回到标题.
import { h, replay, reloadWith } from '../dom.js';
import { Menu } from '../Menu.js';
import { WAVES } from '../../core/config.js';

export class PauseMenu {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    const el = (this.el = h('section', 'fish-screen fish-pause'));
    el.innerHTML = `
      <div class="fish-pause__inner">
        <div class="fish-kicker fish-pause__kicker"><i></i><span class="fish-pause__wave"></span><i></i></div>
        <h2 class="fish-pause__title">暂停</h2>
        <nav class="fish-pause__menu">
          <button class="fish-btn" data-act="resume">继续</button>
          <button class="fish-btn" data-act="restart">重新开始本关</button>
          <button class="fish-btn" data-act="controls">操作说明</button>
          <button class="fish-btn" data-act="title">回到标题</button>
        </nav>
        <div class="fish-hint"><kbd>Esc</kbd> 继续 · 点击画面恢复视角</div>
      </div>`;
    this.waveEl = el.querySelector('.fish-pause__wave');

    const g = this.game;
    this.menu = new Menu(g, { armDelay: 0.2 });
    this.menu.add(el.querySelector('[data-act="resume"]'), () => g.director?.resume?.());
    this.menu.add(el.querySelector('[data-act="restart"]'), () => this.ui.retry());
    this.menu.add(el.querySelector('[data-act="controls"]'), () => this.ui.controls.open(this.menu));
    this.menu.add(el.querySelector('[data-act="title"]'), () => reloadWith({ autostart: null, wave: null }));
  }

  show() {
    const wave = WAVES[this.game.director?.waveIndex ?? 0];
    this.waveEl.textContent = wave ? `${wave.title} · ${wave.subtitle}` : '';
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
