// Cinematic framing: 2.39:1 letterbox bars, the 「按 Enter 跳过」 hint and a
// cinematic location card shown when the intro camera dives.
import { h, replay } from '../dom.js';

export class Letterbox {
  constructor(ui) {
    this.ui = ui;
    const el = (this.el = h('div', 'fish-letterbox'));
    el.innerHTML = `
      <div class="fish-letterbox__bar fish-letterbox__bar--top"></div>
      <div class="fish-letterbox__bar fish-letterbox__bar--bot"></div>
      <div class="fish-skip"><span>按</span><kbd>Enter</kbd><span>跳过</span></div>
      <div class="fish-location">
        <div class="fish-location__l1">东海 · 外海</div>
        <div class="fish-location__l2">水下二十米</div>
      </div>`;
    this.skipEl = el.querySelector('.fish-skip');
    this.locEl = el.querySelector('.fish-location');
    this._locT = 0;
  }

  setBars(on) {
    this.el.classList.toggle('is-on', on);
  }

  setSkip(on) {
    this.skipEl.classList.toggle('is-on', on);
  }

  showLocation(seconds = 3.4) {
    this._locT = seconds;
    this.locEl.classList.add('is-on');
    replay(this.locEl);
  }

  hideLocation() {
    this._locT = 0;
    this.locEl.classList.remove('is-on');
  }

  update(rdt) {
    if (this._locT > 0) {
      this._locT -= rdt;
      if (this._locT <= 0) this.hideLocation();
    }
  }
}
