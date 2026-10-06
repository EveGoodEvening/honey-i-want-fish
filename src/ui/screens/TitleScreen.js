// Title screen: 「老公，我想吃鱼了」 revealed like ink spreading in water over
// the live 3D scene and a quiet menu (下水 / 操作 / 画质 / 第三方许可).
import { h, charSpans, replay, reloadWith } from '../dom.js';
import { Menu } from '../Menu.js';

const QUALITIES = ['low', 'medium', 'high'];
const QUALITY_LABEL = { low: '低', medium: '中', high: '高' };
const INK_SETTLE_MS = 4200; // keep in sync with the SMIL animation below

export class TitleScreen {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    const el = (this.el = h('section', 'fish-screen fish-title'));
    el.innerHTML = `
      <div class="fish-title__veil"></div>
      <div class="fish-title__side"><span>东海</span><i></i><span>外海 · 水下二十米</span></div>
      <div class="fish-title__block">
        <div class="fish-kicker"><i></i><span>深海 · 晚餐</span><i></i></div>
        <h1 class="fish-title__main" aria-label="老公，我想吃鱼了">${charSpans('老公，我想吃鱼了')}</h1>
        <div class="fish-title__en">Honey, I want fish</div>
        <nav class="fish-title__menu">
          <button class="fish-btn fish-btn--primary" data-act="start">下水</button>
          <button class="fish-btn" data-act="controls">操作</button>
          <div class="fish-btn fish-quality" data-act="quality">
            <span class="fish-quality__lbl">画质</span>
            ${QUALITIES.map((q) => `<span class="fish-quality__opt" data-q="${q}">${QUALITY_LABEL[q]}</span>`).join('')}
          </div>
          <button class="fish-btn fish-btn--small" data-act="notices">第三方许可</button>
        </nav>
      </div>
      <div class="fish-title__foot">一个人　·　一把刀　·　一顿晚饭</div>
      <svg class="fish-defs" width="0" height="0" aria-hidden="true" focusable="false">
        <filter id="fish-ink-filter" x="-15%" y="-60%" width="130%" height="220%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.011 0.042" numOctaves="2" seed="11" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="0" xChannelSelector="R" yChannelSelector="G">
            <animate attributeName="scale" begin="indefinite" dur="${INK_SETTLE_MS / 1000}s" values="85;18;0"
              keyTimes="0;0.45;1" calcMode="spline" keySplines="0.3 0.5 0.4 1;0.3 0.6 0.3 1" fill="freeze" />
          </feDisplacementMap>
        </filter>
      </svg>`;

    this.titleEl = el.querySelector('.fish-title__main');
    this.inkAnim = el.querySelector('animate');
    this.qualityEl = el.querySelector('.fish-quality');
    this.qualityOpts = [...el.querySelectorAll('.fish-quality__opt')];
    this.pendingQuality = this.game.quality;
    this._inkTimer = 0;

    this.menu = new Menu(this.game, { armDelay: 0.5 });
    this.menu.add(el.querySelector('[data-act="start"]'), () => this.start());
    this.menu.add(el.querySelector('[data-act="controls"]'), () => this.ui.controls.open(this.menu));
    this.menu.add(this.qualityEl, (e) => this._qualityActivate(e), {
      left: () => this._qualityStep(-1),
      right: () => this._qualityStep(1),
    });
    this.menu.add(el.querySelector('[data-act="notices"]'), () => this.ui.notices.open(this.menu));
    this._renderQuality();
  }

  show() {
    this.el.classList.add('is-on');
    this.pendingQuality = this.game.quality;
    this._renderQuality();
    // Ink-in-water reveal: per-character CSS animation + a settling SVG
    // displacement on the whole line. The filter is dropped once settled so
    // it costs nothing afterwards.
    this.titleEl.classList.add('is-inking');
    replay(this.el);
    try {
      this.inkAnim.beginElement();
    } catch {
      /* SMIL unsupported → the CSS reveal alone still works */
    }
    clearTimeout(this._inkTimer);
    this._inkTimer = setTimeout(() => this.titleEl.classList.remove('is-inking'), INK_SETTLE_MS + 100);
    this.menu.open(0);
  }

  hide() {
    this.el.classList.remove('is-on');
    this.menu.close();
  }

  start() {
    const g = this.game;
    if (g.state !== 'title') return;
    g.audio?.unlock?.();
    if (!g.debug.freeMouse) g.input.requestPointerLock?.();
    g.director?.startGame?.(0);
  }

  _qualityStep(dir) {
    const i = QUALITIES.indexOf(this.pendingQuality);
    this.pendingQuality = QUALITIES[Math.max(0, Math.min(QUALITIES.length - 1, i + dir))];
    this._renderQuality();
    this.game.audio?.play?.('uiHover');
  }

  _qualityActivate(e) {
    const clicked = e?.target?.closest?.('[data-q]')?.dataset.q;
    if (clicked) this.pendingQuality = clicked;
    else if (!e && this.pendingQuality === this.game.quality) {
      // Enter on the row with nothing pending: cycle to the next setting.
      this._qualityStep(this.pendingQuality === 'high' ? -2 : 1);
      return;
    }
    this._renderQuality();
    if (this.pendingQuality !== this.game.quality) {
      // Remember the choice for later visits (the default quality is read from here).
      try {
        localStorage.setItem('fish.quality', this.pendingQuality);
      } catch {
        /* storage blocked (private mode / sandbox): the URL param still applies */
      }
      reloadWith({ quality: this.pendingQuality });
    }
  }

  _renderQuality() {
    for (const opt of this.qualityOpts) {
      opt.classList.toggle('is-current', opt.dataset.q === this.game.quality);
      opt.classList.toggle('is-pending', opt.dataset.q === this.pendingQuality && this.pendingQuality !== this.game.quality);
    }
  }

  update(rdt) {
    if (!this.ui.isModalOpen()) this.menu.update(rdt);
  }
}
