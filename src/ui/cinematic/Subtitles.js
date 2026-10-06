// Film subtitles fed by the Director's `subtitle {speaker, text, duration}`
// event. Two alternating lines so a new line cross-fades over the old one.
// A line without a speaker renders as a sound caption (e.g. ［ 手机震动 ］).
import { h } from '../dom.js';

export class Subtitles {
  constructor(ui) {
    this.ui = ui;
    this.el = h('div', 'fish-subs');
    this.lines = [0, 1].map(() => {
      const line = h('div', 'fish-sub');
      line.innerHTML = '<div class="fish-sub__who"></div><div class="fish-sub__line"></div>';
      this.el.appendChild(line);
      return { el: line, who: line.firstChild, text: line.lastChild, t: 0 };
    });
    this._cur = 0;
  }

  show({ speaker = '', text = '', duration = 3 } = {}) {
    if (!text) return;
    const prev = this.lines[this._cur];
    prev.el.classList.remove('is-on');
    prev.t = 0;
    this._cur ^= 1;
    const line = this.lines[this._cur];
    const caption = !speaker;
    line.el.classList.toggle('is-caption', caption);
    line.who.textContent = speaker;
    line.text.textContent = caption ? text : `「${text}」`;
    line.t = Math.max(0.8, +duration || 3);
    line.el.classList.add('is-on');
  }

  clear() {
    for (const line of this.lines) {
      line.t = 0;
      line.el.classList.remove('is-on');
    }
  }

  update(rdt) {
    for (const line of this.lines) {
      if (line.t > 0) {
        line.t -= rdt;
        if (line.t <= 0) line.el.classList.remove('is-on');
      }
    }
  }
}
