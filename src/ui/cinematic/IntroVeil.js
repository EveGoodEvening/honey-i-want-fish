// The phone call happens in the dark: a near-black veil over the intro shot
// (under the letterbox and subtitles) with a small phone face-up in the lower
// right — its lit screen reads 「老婆 / 来电」 over answer / decline keys — that
// buzzes while the cool glow it throws throbs (in step with the 2.1 s
// 'phoneRing' cycle; the screen stays lit through the ring, which the title →
// intro dip half covers; the call is picked up after one cycle, the screen
// turns to 「通话中」 and dims through the call). On the cinematic 'dive' cue
// the veil lifts in 0.35 s on the surface-entry flash; leaving the intro
// removes it at once (a skip dips to black — UI.dip covers that cut; at the
// natural end it has long lifted).
import { h, replay } from '../dom.js';

export class IntroVeil {
  constructor(ui) {
    this.ui = ui;
    this.el = h(
      'div',
      'fish-introveil',
      `<div class="fish-introveil__phone">
        <div class="fish-phone">
          <div class="fish-phone__who">老婆</div>
          <div class="fish-phone__what"><span class="fish-phone__ring">来电</span><span class="fish-phone__call">通话中</span></div>
          <div class="fish-phone__keys"><i class="fish-phone__no"></i><i class="fish-phone__yes"></i></div>
        </div>
      </div>`,
    );
  }

  show() {
    this.el.classList.remove('is-lifted');
    this.el.classList.add('is-on');
    replay(this.el);
  }

  /** The camera goes under: fade the veil out. */
  lift() {
    if (this.el.classList.contains('is-on')) this.el.classList.add('is-lifted');
  }

  hide() {
    this.el.classList.remove('is-on', 'is-lifted', 'is-play');
  }
}
