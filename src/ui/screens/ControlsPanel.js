// 操作说明 — modal list of the controls (docs/DESIGN.md "Controls"). Opened
// from the title screen and the pause menu; Esc / Enter / 返回 closes it.
import { h } from '../dom.js';
import { Menu } from '../Menu.js';

const k = (...keys) => keys.map((key) => (key === '/' ? '<em>/</em>' : `<kbd>${key}</kbd>`)).join('');

const ROWS = [
  ['游动', k('W', 'A', 'S', 'D', '/', '方向键'), '随镜头方向，可上下俯仰'],
  ['上浮 · 下潜', k('Space', '/', 'C'), ''],
  ['视角', k('鼠标'), ''],
  ['闪避', k('Shift'), '短距冲刺，带无敌帧，耗体力'],
  ['轻斩', k('左键', '/', 'J'), '三段连斩'],
  ['重刺', k('右键', '/', 'K'), '按住蓄力，松开突刺'],
  ['格挡', k('E', '/', 'L'), '看准时机，弹开撕咬与冲撞；蓄力中也可格挡'],
  ['锁定', k('Q', '/', 'Tab', '/', '中键'), '锁定视野内最近的鱼'],
  ['暂停', k('Esc', '/', 'P'), ''],
  ['被咬住', `<b>狂按</b>${k('左键', '/', 'J')}`, '刺它的眼，挣脱'],
];

export class ControlsPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.isOpen = false;
    this._returnMenu = null;

    const el = (this.el = h('section', 'fish-panel fish-controls'));
    el.innerHTML = `
      <div class="fish-controls__box">
        <div class="fish-controls__head"><i></i><h3>操作</h3><i></i></div>
        <div class="fish-controls__grid">
          ${ROWS.map(([name, keys, note]) => `
            <div class="fish-controls__name">${name}</div>
            <div class="fish-controls__keys">${keys}</div>
            <div class="fish-controls__note">${note}</div>`).join('')}
        </div>
        <p class="fish-controls__tip">鱼的眼与鳃是要害。贴着它的嘴闪开，时间会慢下来。</p>
        <div class="fish-controls__foot"><button class="fish-btn fish-btn--small">返回</button></div>
      </div>`;

    this.menu = new Menu(this.game, { armDelay: 0.15, onBack: () => this.close() });
    this.menu.add(el.querySelector('button'), () => this.close());
    // Clicking the dimmed backdrop also closes.
    el.addEventListener('mousedown', (e) => {
      if (e.target === el && this.menu.isArmed()) this.close();
    });
  }

  /** @param {import('../Menu.js').Menu|null} returnMenu menu to suspend while open */
  open(returnMenu = null) {
    if (this.isOpen) return;
    this.isOpen = true;
    this._returnMenu = returnMenu;
    returnMenu?.suspend(true);
    this.el.classList.add('is-on');
    // The host screen's big type (title / 暂停) steps back behind the panel.
    this.ui.el.classList.add('has-panel');
    this.menu.open(0);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.classList.remove('is-on');
    this.ui.el.classList.remove('has-panel');
    this.menu.close();
    this._returnMenu?.suspend(false);
    this._returnMenu = null;
  }

  update(rdt) {
    if (this.isOpen) this.menu.update(rdt);
  }
}
