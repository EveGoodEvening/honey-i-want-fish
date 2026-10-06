// Wave title card shown during 'transition': 第一条鱼 / 大白鲨 / species line /
// the wave's intro sentence. Staggered CSS reveal; fades out when combat starts.
import { h, replay } from '../dom.js';
import { WAVES } from '../../core/config.js';

// Documentary-style species captions, keyed by enemy type.
const SPECIES = {
  greatWhite: { latin: 'Carcharodon carcharias', size: '体长约 6 米' },
  tiger: { latin: 'Galeocerdo cuvier', size: '体长约 4.5 米' },
  megalodon: { latin: 'Otodus megalodon', size: '体长约 16 米' },
};
const COUNT = ['', '', '两条', '三条', '四条'];

export class WaveCard {
  constructor(ui) {
    this.ui = ui;
    const el = (this.el = h('div', 'fish-card'));
    el.innerHTML = `
      <div class="fish-card__num"></div>
      <div class="fish-card__rule"></div>
      <div class="fish-card__name"></div>
      <div class="fish-card__latin"></div>
      <div class="fish-card__intro"></div>`;
    this.numEl = el.querySelector('.fish-card__num');
    this.nameEl = el.querySelector('.fish-card__name');
    this.latinEl = el.querySelector('.fish-card__latin');
    this.introEl = el.querySelector('.fish-card__intro');
    this.index = -1;
  }

  show(index) {
    const wave = WAVES[index];
    if (!wave) return;
    this.index = index;
    this.numEl.textContent = wave.title;
    this.nameEl.textContent = wave.subtitle;
    this.introEl.textContent = wave.intro ?? '';
    const type = wave.enemies?.[0]?.type;
    const sp = SPECIES[type];
    const n = wave.enemies?.length ?? 1;
    this.latinEl.textContent = sp ? [sp.latin, COUNT[n] || '', sp.size].filter(Boolean).join('　·　') : '';
    this.el.classList.toggle('is-boss', !!wave.boss);
    this.el.classList.add('is-on');
    replay(this.el);
  }

  hide() {
    this.el.classList.remove('is-on');
  }
}
