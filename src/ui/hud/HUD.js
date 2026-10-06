// In-play HUD: health/stamina, enemy bars, lock reticle, off-screen threat
// arcs, damage-direction arcs, combat words, grab QTE, low-HP heartbeat
// border, first-wave control tips (movement row + combat row), the first-time
// parry-cue hint, pointer-lock hint and the fps readout.
// Nothing here takes pointer events.
//
// The HUD shows in 'transition' too (the wave card), but fades in only once
// the intro / victory letterbox has retracted (ui.css: transition-delay on
// .fish[data-state='transition'] .fish-hud.is-on) so nothing peeks out from
// under the bars.
import { h, isAutomated } from '../dom.js';
import { PLAYER } from '../../core/config.js';
import { viewport, projectPoint, makeProjection } from '../projection.js';
import { PlayerBars } from './PlayerBars.js';
import { EnemyBars } from './EnemyBars.js';
import { LockReticle } from './LockReticle.js';
import { ThreatIndicators } from './ThreatIndicators.js';
import { HitDirection } from './HitDirection.js';
import { CombatText } from './CombatText.js';
import { GrabPrompt } from './GrabPrompt.js';
import { StrikeHint } from './StrikeHint.js';

const LOW_HP = 0.3;
const TIPS_TIME = 12;
// 「现在 —— E 格挡」 on this many enemy:strike cues of wave 0 (once per page session).
const STRIKE_HINTS = 2;

export class HUD {
  constructor(ui) {
    this.ui = ui;
    const game = (this.game = ui.game);
    const el = (this.el = h('div', 'fish-hud'));

    this.lowhp = h('div', 'fish-lowhp');
    el.appendChild(this.lowhp);
    this.threats = new ThreatIndicators(el);
    this.hitdir = new HitDirection(el);
    this.reticle = new LockReticle(el);
    this.ctext = new CombatText(el);
    this.strikeHint = new StrikeHint(el);
    this.grab = new GrabPrompt(el, game);
    this.player = new PlayerBars(el);
    this.enemyBars = new EnemyBars(el, game);

    // Two centred rows, clear of the player bars bottom-left.
    this.tips = h(
      'div',
      'fish-tips',
      '<div class="fish-tips__row"><span><kbd>WASD</kbd>游动</span>' +
        '<span><kbd>Space</kbd><em>/</em><kbd>C</kbd>上下</span></div>' +
        '<div class="fish-tips__row"><span><kbd>左键</kbd>斩</span><span><kbd>右键</kbd>重刺</span>' +
        '<span><kbd>E</kbd>格挡</span><span><kbd>Shift</kbd>闪避</span><span><kbd>Q</kbd>锁定</span></div>',
    );
    this.lockHint = h('div', 'fish-lockhint', '点击画面　·　控制视角');
    this.fps = h('div', 'fish-fps');
    el.append(this.tips, this.lockHint);
    // this.fps is mounted by UI above everything (visible in every state).

    // enemy → game time (scaled, like the telegraph durations) until which it
    // counts as "telegraphing"
    this._telegraph = new Map();
    this.isHot = (enemy) => !!enemy && (this._telegraph.get(enemy) ?? 0) > this.game.time.elapsed;

    this._p = makeProjection();
    this._w = { on: null, combat: null, low: -1, hint: null, tips: null };
    this._beat = 0;
    this._tipsT = 0;
    this._tipsShown = false;
    this._strikeHints = STRIKE_HINTS;
    this._fpsT = 0;

    this._listen();
  }

  _listen() {
    const g = this.game;
    const ev = g.events;
    const now = () => g.time.elapsed;

    ev.on('enemy:telegraph', ({ enemy, duration } = {}) => {
      if (!enemy) return;
      const d = typeof duration === 'number' && duration > 0 ? duration : 0.9;
      this._telegraph.set(enemy, now() + d + 0.25);
    });
    ev.on('enemy:attack', ({ enemy } = {}) => {
      if (!enemy) return;
      this._telegraph.set(enemy, Math.max(this._telegraph.get(enemy) ?? 0, now() + 0.45));
    });
    // The attack is about to connect (parry cue): red arc, and the lock
    // reticle snaps tight for 0.2 s if it is on the striker.
    ev.on('enemy:strike', ({ enemy } = {}) => {
      if (!enemy) return;
      this._telegraph.set(enemy, Math.max(this._telegraph.get(enemy) ?? 0, now() + 0.35));
      if (enemy === g.cameraRig?.lockTarget) this.reticle.strike(0.2);
      // First-time guidance: name the moment the flash + sound mean.
      if (this._strikeHints > 0 && g.state === 'playing' && (g.director?.waveIndex ?? 0) === 0) {
        this._strikeHints--;
        this.strikeHint.show(enemy);
      }
    });
    ev.on('enemy:hit', ({ enemy, critical, position } = {}) => {
      if (enemy) this.enemyBars.onHit(enemy);
      if (critical) this._crit(position);
    });
    ev.on('enemy:roar', ({ enemy } = {}) => {
      this.enemyBars.onRoar(enemy);
      if (enemy) this._telegraph.set(enemy, Math.max(this._telegraph.get(enemy) ?? 0, now() + 1.2));
    });
    ev.on('wave:start', ({ index, retry } = {}) => {
      this._telegraph.clear();
      this.enemyBars.rebuild(g.enemies?.enemies, index ?? g.director?.waveIndex ?? 0);
      if (index === 0 && !this._tipsShown) {
        this._tipsShown = true;
        this._tipsT = TIPS_TIME;
      }
      if (retry) {
        // A retry from the pause menu goes paused → playing, which the
        // game:state handler below treats as a resume: drop the old attempt.
        this.player.snap(g.player);
        this.grab.hide();
        this.hitdir.clear();
        this.ctext.clear();
        this.strikeHint.hide();
      }
    });
    ev.on('player:parry', (e = {}) => {
      if (!e.success) return;
      this.ctext.centre('parry', '格挡');
      this.strikeHint.hurry();
    });
    ev.on('player:perfectDodge', () => {
      this.ctext.centre('dodge', '闪避');
      this.strikeHint.hurry();
    });
    ev.on('player:hit', ({ sourcePosition, heavy } = {}) => {
      this.hitdir.add(sourcePosition, !!heavy);
      this.player.onHit(!!heavy);
      this.strikeHint.hurry();
    });
    ev.on('grab:start', () => this.grab.start());
    ev.on('grab:progress', ({ value } = {}) => this.grab.progress(value));
    // `interrupted` (retry, state change, shark gone): no outcome to show.
    ev.on('grab:end', ({ success, interrupted } = {}) => this.grab.end(!!success, !!interrupted));
    ev.on('game:state', ({ from, to } = {}) => {
      if (to !== 'playing' && to !== 'paused') this.grab.hide();
      if (to === 'dead' || to === 'title' || to === 'transition') {
        this.hitdir.clear();
        this.ctext.clear();
      }
      if (to !== 'playing') this.strikeHint.hide();
      if (to === 'playing' && from !== 'paused') this.player.snap(g.player);
    });
  }

  _crit(position) {
    let x = viewport.w * 0.5;
    let y = viewport.h * 0.42;
    if (position) {
      const p = projectPoint(this.game.camera, position, this._p, 0.9);
      if (p.onScreen) {
        x = p.x;
        y = p.y - viewport.h * 0.04;
      }
    }
    this.ctext.show('crit', '要害', x, y);
  }

  update(rdt) {
    const g = this.game;
    const st = g.state;
    const w = this._w;
    const on = st === 'playing' || st === 'paused' || st === 'transition';
    const combat = st === 'playing' || st === 'paused';
    if (on !== w.on) {
      w.on = on;
      this.el.classList.toggle('is-on', on);
    }
    if (combat !== w.combat) {
      w.combat = combat;
      this.el.classList.toggle('is-combat', combat);
    }

    const player = g.player;
    const enemies = g.enemies?.enemies;
    const camera = g.camera;

    if (on) this.player.update(rdt, player);

    if (this.enemyBars.isStale(enemies)) this.enemyBars.rebuild(enemies, g.director?.waveIndex ?? 0);
    this.enemyBars.update(rdt, combat, this.isHot);

    if (combat) {
      this.threats.update(camera, enemies, player?.position, this.isHot);
      const target = g.cameraRig?.lockTarget ?? null;
      this.reticle.update(camera, target, this.isHot(target), rdt);
      this.strikeHint.update(camera, this.reticle, this.threats, st === 'playing');
    } else {
      this.threats.hideAll();
      this.reticle.update(camera, null, false, rdt);
    }
    this.hitdir.update(rdt, camera);
    this.grab.update(rdt, combat, st === 'paused');

    this._updateLowHp(rdt, combat, player);
    this._updateHints(rdt, st);

    if (st === 'playing' && player && g.input.pressed('dodge') && (player.stamina ?? 0) < PLAYER.dodgeCost) {
      this.player.onStaminaDenied();
    }

    if (g.debug.stats) {
      this._fpsT -= rdt;
      if (this._fpsT <= 0) {
        this._fpsT = 0.5;
        const s = g.stats;
        this.fps.textContent = `${s.fps} fps · ${s.frameMs} ms · ${s.drawCalls} dc · ${Math.round(s.triangles / 1000)}k tri · ${g.quality}`;
      }
    }
  }

  // A soft red border that thumps like a heartbeat ("lub-dub") below 30 % HP,
  // faster as danger rises. PostFX handles the heavy vignette; this is subtle.
  _updateLowHp(rdt, combat, player) {
    let target = 0;
    if (combat && player && player.alive !== false) {
      const hp = (player.health ?? 0) / (player.maxHealth || PLAYER.maxHealth);
      if (hp < LOW_HP) {
        const k = (LOW_HP - hp) / LOW_HP;
        this._beat = (this._beat + rdt * (1.0 + 0.8 * (this.game.danger || 0))) % 1;
        const ph = this._beat;
        const lub = Math.exp(-ph * 9);
        const dub = ph > 0.2 ? 0.7 * Math.exp(-(ph - 0.2) * 10) : 0;
        target = (0.3 + 0.7 * k) * (0.3 + 0.7 * Math.min(1, lub + dub));
      }
    }
    const q = Math.round(target * 50) / 50;
    if (q !== this._w.low) {
      this._w.low = q;
      this.lowhp.style.opacity = String(q);
    }
  }

  _updateHints(rdt, st) {
    const g = this.game;
    const w = this._w;
    const hint =
      st === 'playing' &&
      !g.input.pointerLocked &&
      !g.debug.freeMouse &&
      !isAutomated &&
      (g.director?.stateTime ?? 1) > 0.8;
    if (hint !== w.hint) {
      w.hint = hint;
      this.lockHint.classList.toggle('is-on', hint);
    }
    if (this._tipsT > 0 && st === 'playing') this._tipsT -= rdt;
    const tips = this._tipsT > 0 && st === 'playing';
    if (tips !== w.tips) {
      w.tips = tips;
      this.tips.classList.toggle('is-on', tips);
    }
  }
}
