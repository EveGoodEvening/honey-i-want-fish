// Transient combat words: 「要害」 (critical, at the wound), 「格挡」 (parry)
// and 「闪避」 (perfect dodge) near the centre. Pooled elements animated with
// the Web Animations API using shared, preallocated keyframes.
//
// The centre words never pile up: parry and dodge have their own anchors
// (CENTRE_Y, a parry sits a little higher than a dodge), and a new centre
// word hurries any running one out (its remaining keyframes play HURRY×
// faster, so it still fades rather than blinking off). 要害 is capped to one
// new word per CRIT_GAP — a combo's quick crits don't stack on one wound.
import { h } from '../dom.js';
import { viewport } from '../projection.js';

const POOL = 5;
const HURRY = 5; // playback rate of a centre word pushed out by a newer one
const CRIT_GAP = 300; // ms (wall clock, like the animations) between two 要害
/** Centre-word anchors as a share of the viewport height. */
export const CENTRE_Y = { parry: 0.58, dodge: 0.66 };

const KEYFRAMES = {
  crit: [
    { transform: 'translate(-50%, -50%) scale(1.7)', opacity: 0, filter: 'blur(6px)' },
    { transform: 'translate(-50%, -50%) scale(0.96)', opacity: 1, filter: 'blur(0px)', offset: 0.14 },
    { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, filter: 'blur(0px)', offset: 0.55 },
    { transform: 'translate(-50%, -90%) scale(1.04)', opacity: 0, filter: 'blur(3px)' },
  ],
  parry: [
    { transform: 'translate(-50%, -50%) scale(0.7)', opacity: 0, letterSpacing: '0.1em' },
    { transform: 'translate(-50%, -50%) scale(1.06)', opacity: 1, letterSpacing: '0.55em', offset: 0.16 },
    { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, letterSpacing: '0.6em', offset: 0.6 },
    { transform: 'translate(-50%, -50%) scale(1)', opacity: 0, letterSpacing: '0.75em' },
  ],
  dodge: [
    { transform: 'translate(-30%, -50%)', opacity: 0, filter: 'blur(8px)' },
    { transform: 'translate(-50%, -50%)', opacity: 1, filter: 'blur(0px)', offset: 0.22 },
    { transform: 'translate(-52%, -50%)', opacity: 1, filter: 'blur(0px)', offset: 0.62 },
    { transform: 'translate(-70%, -50%)', opacity: 0, filter: 'blur(6px)' },
  ],
};
const OPTS = {
  crit: { duration: 900, easing: 'cubic-bezier(.2,.7,.3,1)' },
  parry: { duration: 1100, easing: 'cubic-bezier(.2,.7,.3,1)' },
  dodge: { duration: 1200, easing: 'cubic-bezier(.3,.6,.3,1)' },
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class CombatText {
  constructor(parent) {
    this.el = h('div', 'fish-ctexts');
    parent.appendChild(this.el);
    this.items = [];
    for (let i = 0; i < POOL; i++) {
      const el = h('div', 'fish-ctext', '<span></span>');
      this.el.appendChild(el);
      this.items.push({ el, span: el.firstChild, kind: '', anim: null, born: 0 });
    }
    this._clock = 0;
    this._critAt = -Infinity;
  }

  /** A centre word ('parry' | 'dodge') at its own anchor. */
  centre(kind, text) {
    this.show(kind, text, viewport.w * 0.5, viewport.h * (CENTRE_Y[kind] ?? 0.6));
  }

  /** kind: 'crit' | 'parry' | 'dodge'; x/y in CSS px. */
  show(kind, text, x, y) {
    if (kind === 'crit') {
      const t = now();
      if (t - this._critAt < CRIT_GAP) return;
      this._critAt = t;
    } else {
      // One centre word at a time: hurry the running one out.
      for (const it of this.items) {
        if (it.anim && it.kind !== 'crit' && it.anim.playState === 'running') it.anim.updatePlaybackRate(HURRY);
      }
    }
    let slot = this.items[0];
    for (const it of this.items) {
      if (!it.anim || it.anim.playState === 'finished') {
        slot = it;
        break;
      }
      if (it.born < slot.born) slot = it;
    }
    slot.anim?.cancel();
    if (slot.kind !== kind) {
      slot.el.classList.remove(`is-${slot.kind}`);
      slot.el.classList.add(`is-${kind}`);
      slot.kind = kind;
    }
    slot.span.textContent = text;
    slot.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    slot.born = ++this._clock;
    slot.anim = slot.span.animate(KEYFRAMES[kind], OPTS[kind]);
  }

  clear() {
    for (const it of this.items) {
      it.anim?.cancel();
      it.anim = null;
    }
    this._critAt = -Infinity;
  }
}
