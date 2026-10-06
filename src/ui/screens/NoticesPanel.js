// Third-party license text comes from the same file published with the game.
import { h } from '../dom.js';
import { Menu } from '../Menu.js';

export class NoticesPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.isOpen = false;
    this._returnMenu = null;
    this._noticeRequest = null;

    const el = (this.el = h('section', 'fish-panel fish-notices'));
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'fish-notices-heading');
    el.innerHTML = `
      <div class="fish-notices__box">
        <div class="fish-notices__head"><i></i><h3 id="fish-notices-heading">第三方许可</h3><i></i></div>
        <pre class="fish-notices__text" lang="en" aria-live="polite"></pre>
        <div class="fish-notices__foot"><button class="fish-btn fish-btn--small">返回</button></div>
      </div>`;
    this.text = el.querySelector('pre');
    this.menu = new Menu(this.game, { armDelay: 0.15, onBack: () => this.close() });
    this.menu.add(el.querySelector('button'), () => this.close());
    el.addEventListener('mousedown', (e) => {
      if (e.target === el && this.menu.isArmed()) this.close();
    });
  }

  open(returnMenu) {
    if (this.isOpen) return;
    this.isOpen = true;
    this._returnMenu = returnMenu;
    returnMenu.suspend(true);
    this.el.classList.add('is-on');
    this.ui.el.classList.add('has-panel');
    this.text.scrollTop = 0;
    this.menu.open(0);

    if (!this._noticeRequest) {
      this.text.textContent = '正在加载许可声明…';
      this._noticeRequest = fetch(`${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.txt`)
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        })
        .then((text) => { this.text.textContent = text; })
        .catch(() => { this.text.textContent = '许可声明加载失败，请刷新页面后重试。'; });
    }
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.classList.remove('is-on');
    this.ui.el.classList.remove('has-panel');
    this.menu.close();
    this._returnMenu.suspend(false);
    this._returnMenu = null;
  }

  update(rdt) {
    if (!this.isOpen) return;
    if (this.menu.isArmed()) {
      const scroll = this.game.input.axis('back', 'forward');
      if (scroll) this.text.scrollTop += scroll * rdt * 360;
    }
    this.menu.update(rdt);
  }
}
