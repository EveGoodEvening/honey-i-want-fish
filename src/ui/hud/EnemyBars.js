// Top-centre enemy bar(s) for the current wave: name + wave title, a thin
// blood-coloured bar with a lagging segment. One large bar for a single fish
// (phase ticks at 60 % / 25 % for the boss); slim side-by-side bars for packs.
import { h, clamp01, damp, q3 } from '../dom.js';
import { WAVES } from '../../core/config.js';

const LAG_HOLD = 0.5;
const MAX_BARS = 4;
const PACK_LABELS = ['甲', '乙', '丙', '丁'];
const BOSS_PHASES = [0.6, 0.25];

const HIT_FLASH = [{ opacity: 0.85 }, { opacity: 0 }];
const HIT_FLASH_OPTS = { duration: 240, easing: 'ease-out' };
const ROAR = [
  { transform: 'translate(-50%, 0)' },
  { transform: 'translate(calc(-50% - 4px), 1px)' },
  { transform: 'translate(calc(-50% + 4px), -1px)' },
  { transform: 'translate(calc(-50% - 2px), 0)' },
  { transform: 'translate(calc(-50% + 2px), 0)' },
  { transform: 'translate(-50%, 0)' },
];
const ROAR_OPTS = { duration: 700, easing: 'ease-out' };

export class EnemyBars {
  constructor(parent, game) {
    this.game = game;
    const el = (this.el = h('div', 'fish-boss'));
    el.innerHTML = `
      <div class="fish-boss__kicker"></div>
      <div class="fish-boss__name"></div>
      <div class="fish-boss__bars"></div>`;
    parent.appendChild(el);
    this.kickerEl = el.querySelector('.fish-boss__kicker');
    this.nameEl = el.querySelector('.fish-boss__name');
    this.barsEl = el.querySelector('.fish-boss__bars');
    this.bars = [];
    this.visible = false;
    this._allDeadFor = 0;
    this._source = null; // the enemies array the bars were built from
    this._sourceLen = -1;
  }

  /** (Re)build bars for the given enemies; cheap enough to call on wave start / spawn. */
  rebuild(enemies, waveIndex) {
    const list = (enemies ?? []).slice(0, MAX_BARS);
    this._source = enemies;
    this._sourceLen = enemies?.length ?? 0;
    this.barsEl.textContent = '';
    this.bars.length = 0;
    const wave = WAVES[waveIndex] ?? null;
    const multi = list.length > 1;
    const boss = !multi && !!(list[0]?.isBoss || wave?.boss);
    this.el.classList.toggle('is-multi', multi);
    this.el.classList.toggle('is-boss', boss);
    this.kickerEl.textContent = wave?.title ?? '';
    this.nameEl.textContent = multi ? wave?.subtitle ?? list[0]?.name ?? '' : list[0]?.name ?? wave?.subtitle ?? '';

    list.forEach((enemy, i) => {
      const wrap = h('div', 'fish-ebar');
      wrap.innerHTML = `
        <div class="fish-ebar__track"><i class="fish-ebar__lag"></i><i class="fish-ebar__fill"></i><i class="fish-ebar__flash"></i></div>
        ${multi ? `<div class="fish-ebar__label">${PACK_LABELS[i]}</div>` : ''}`;
      const ticks = [];
      if (boss) {
        const phases = Array.isArray(enemy.phaseThresholds) ? enemy.phaseThresholds : BOSS_PHASES;
        for (const p of phases) {
          const t = h('i', 'fish-ebar__tick');
          t.style.left = `${p * 100}%`;
          wrap.appendChild(t);
          ticks.push({ el: t, at: p, passed: false });
        }
      }
      this.barsEl.appendChild(wrap);
      const ratio = clamp01((enemy.health ?? 0) / (enemy.maxHealth || 1));
      this.bars.push({
        enemy,
        wrap,
        fill: wrap.querySelector('.fish-ebar__fill'),
        lag: wrap.querySelector('.fish-ebar__lag'),
        flash: wrap.querySelector('.fish-ebar__flash'),
        ticks,
        shown: ratio,
        lagV: ratio,
        hold: 0,
        wFill: -1,
        wLag: -1,
        dead: false,
        hot: false,
      });
    });
    this._allDeadFor = 0;
  }

  /** True when the manager's enemy list changed identity/length since the last build. */
  isStale(enemies) {
    return enemies !== this._source || (enemies?.length ?? 0) !== this._sourceLen;
  }

  onHit(enemy) {
    const bar = this._find(enemy);
    if (!bar) return;
    bar.hold = LAG_HOLD;
    bar.flash.animate(HIT_FLASH, HIT_FLASH_OPTS);
  }

  onRoar(enemy) {
    if (!this._find(enemy)) return;
    this.el.animate(ROAR, ROAR_OPTS);
  }

  _find(enemy) {
    for (let i = 0; i < this.bars.length; i++) if (this.bars[i].enemy === enemy) return this.bars[i];
    return null;
  }

  /**
   * @param {number} rdt
   * @param {boolean} allowed  HUD is in a combat state
   * @param {(enemy) => boolean} isHot  enemy is telegraphing
   */
  update(rdt, allowed, isHot) {
    let anyAlive = false;
    for (let i = 0; i < this.bars.length; i++) {
      const b = this.bars[i];
      const e = b.enemy;
      const ratio = clamp01((e.health ?? 0) / (e.maxHealth || 1));
      if (e.alive !== false) anyAlive = true;

      if (ratio < b.shown) b.shown = ratio;
      else b.shown += (ratio - b.shown) * damp(6, rdt);
      if (ratio >= b.lagV) b.lagV = b.shown;
      else if (b.hold > 0) b.hold -= rdt;
      else b.lagV += (ratio - b.lagV) * damp(2.6, rdt);

      const f = q3(b.shown);
      if (f !== b.wFill) {
        b.wFill = f;
        b.fill.style.transform = `scaleX(${f})`;
      }
      const l = q3(Math.max(b.lagV, b.shown));
      if (l !== b.wLag) {
        b.wLag = l;
        b.lag.style.transform = `scaleX(${l})`;
      }
      for (let k = 0; k < b.ticks.length; k++) {
        const t = b.ticks[k];
        const passed = ratio <= t.at;
        if (passed !== t.passed) {
          t.passed = passed;
          t.el.classList.toggle('is-passed', passed);
        }
      }
      const dead = e.alive === false;
      if (dead !== b.dead) {
        b.dead = dead;
        b.wrap.classList.toggle('is-dead', dead);
      }
      const hot = !dead && isHot(e);
      if (hot !== b.hot) {
        b.hot = hot;
        b.wrap.classList.toggle('is-hot', hot);
      }
    }
    this._allDeadFor = anyAlive ? 0 : this._allDeadFor + rdt;
    const visible = allowed && this.bars.length > 0 && this._allDeadFor < 2.2;
    if (visible !== this.visible) {
      this.visible = visible;
      this.el.classList.toggle('is-on', visible);
    }
  }
}
