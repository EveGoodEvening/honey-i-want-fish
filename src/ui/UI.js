// UI — DOM overlay inside #ui-root. See docs/DESIGN.md "UI".
//
// Visual language: a cinematic deep-sea adventure title sequence. Chinese serif type,
// off-white with a soft glow, hairlines, lots of negative space, grain and
// vignette on full-screen cards; nothing bright or gamey.
//
// Structure (bottom → top):
//   HUD (src/ui/hud/*)            in-play read-outs, never takes pointer events
//   IntroVeil                     black over the intro until the cinematic 'dive'
//   Subtitles / Letterbox / Card  cinematic layers (src/ui/cinematic/*)
//   Title / Pause / Death / Victory screens, sub-panels (src/ui/screens/*)
//   fade (black dips between shots), film grain
//
// Screens become interactive (pointer-events) only while visible, so clicks
// on the canvas during play always reach it for pointer lock.
//
// Everything animates from update(dt) or CSS / WAAPI; per-frame DOM writes
// are limited to transforms/opacity and only when a value changes.
import './ui.css';
import { h, makeNoiseDataURL } from './dom.js';
import { viewport } from './projection.js';
import { HUD } from './hud/HUD.js';
import { Subtitles } from './cinematic/Subtitles.js';
import { Letterbox } from './cinematic/Letterbox.js';
import { IntroVeil } from './cinematic/IntroVeil.js';
import { WaveCard } from './cinematic/WaveCard.js';
import { TitleScreen } from './screens/TitleScreen.js';
import { ControlsPanel } from './screens/ControlsPanel.js';
import { NoticesPanel } from './screens/NoticesPanel.js';
import { PauseMenu } from './screens/PauseMenu.js';
import { DeathScreen } from './screens/DeathScreen.js';
import { VictoryScreen } from './screens/VictoryScreen.js';

const SCREEN_STATES = new Set(['title', 'paused', 'dead', 'victory', 'intro']);
const DIP = [{ opacity: 1 }, { opacity: 0 }];

export class UI {
  constructor(game) {
    this.game = game;
    let root = document.getElementById('ui-root');
    if (!root) {
      root = h('div');
      root.id = 'ui-root';
      document.body.appendChild(root);
    }
    this.root = root;

    const el = (this.el = h('div', `fish fish--q-${game.quality}`));
    el.dataset.state = game.state;
    root.appendChild(el);

    this.hud = new HUD(this);
    this.veil = new IntroVeil(this);
    this.subs = new Subtitles(this);
    this.letterbox = new Letterbox(this);
    this.card = new WaveCard(this);
    this.title = new TitleScreen(this);
    this.pause = new PauseMenu(this);
    this.death = new DeathScreen(this);
    this.victory = new VictoryScreen(this);
    this.controls = new ControlsPanel(this);
    this.notices = new NoticesPanel(this);
    this.fade = h('div', 'fish-fade');
    this.grain = h('div', 'fish-grain');
    const noise = makeNoiseDataURL();
    if (noise) this.grain.style.backgroundImage = `url(${noise})`;

    el.append(
      this.hud.el,
      this.veil.el,
      this.letterbox.el,
      this.subs.el,
      this.card.el,
      this.title.el,
      this.pause.el,
      this.death.el,
      this.victory.el,
      this.controls.el,
      this.notices.el,
      this.fade,
      this.grain,
      this.hud.fps,
    );

    this._measure();
    this._listen();
  }

  // ------------------------------------------------------------------ API

  /** True while a modal sub-panel is open — Director won't treat Esc as "resume". */
  isModalOpen() {
    return this.controls.isOpen || this.notices.isOpen;
  }

  /** Retry the current wave (death screen / pause menu). Call from a user gesture. */
  retry() {
    const g = this.game;
    g.audio?.unlock?.();
    if (g.state === 'paused') this.dip(0.9);
    if (!g.debug.freeMouse) g.input.requestPointerLock?.();
    g.director?.restartWave?.();
  }

  /** New run from the first wave (victory screen). Call from a user gesture. */
  playAgain() {
    const g = this.game;
    g.audio?.unlock?.();
    if (!g.debug.freeMouse) g.input.requestPointerLock?.();
    g.director?.restartGame?.();
  }

  /** Cut to black, then fade the scene back in over `seconds`. */
  dip(seconds = 1) {
    this.fade.animate(DIP, { duration: seconds * 1000, easing: 'cubic-bezier(.5,0,.75,1)' });
  }

  // ------------------------------------------------------------ internals

  _listen() {
    const g = this.game;
    const ev = g.events;
    ev.on('game:state', ({ from, to } = {}) => this._onState(from, to));
    ev.on('subtitle', (e) => this.subs.show(e));
    ev.on('cinematic', ({ name } = {}) => {
      if (name === 'dive' && g.state === 'intro') {
        this.veil.lift();
        this.letterbox.showLocation();
      }
    });
    ev.on('game:resize', () => this._measure());
    window.addEventListener('resize', () => this._measure());

    // Clicking the canvas during play (or cinematics) re-acquires pointer lock.
    g.renderer?.domElement?.addEventListener('click', () => {
      const st = g.state;
      if ((st === 'playing' || st === 'intro' || st === 'transition') && !g.input.pointerLocked && !g.debug.freeMouse) {
        g.input.requestPointerLock?.();
      }
    });
  }

  _measure() {
    viewport.w = this.root.clientWidth || window.innerWidth;
    viewport.h = this.root.clientHeight || window.innerHeight;
  }

  _onState(from, to) {
    const el = this.el;
    el.dataset.state = to;
    el.classList.toggle('has-screen', SCREEN_STATES.has(to));

    // Close sub-panels before their host screens hide (restores host menus).
    if (from === 'title' || from === 'paused') {
      this.controls.close();
      this.notices.close();
    }

    if (to === 'title') this.title.show();
    else this.title.hide();
    if (to === 'paused') this.pause.show();
    else this.pause.hide();
    if (to === 'dead') this.death.show();
    else this.death.hide();
    if (to === 'victory') this.victory.show();
    else this.victory.hide();
    if (to === 'transition') this.card.show(this.game.director?.waveIndex ?? 0);
    else this.card.hide();

    this.letterbox.setBars(to === 'intro' || to === 'victory');
    this.letterbox.setSkip(to === 'intro');
    if (to === 'intro') this.veil.show();
    else this.veil.hide();
    if (from === 'intro') this.letterbox.hideLocation();
    if (from === 'intro' || to === 'dead' || to === 'title' || to === 'victory') this.subs.clear();

    // Black dips hide hard camera cuts between shots.
    if (from === 'title' && to === 'intro') this.dip(1.8);
    else if (from === 'intro' && this._introCut(to)) this.dip(1.0);
    else if (from === 'dead' || from === 'victory') this.dip(1.1);
  }

  /**
   * Leaving the intro: a played-out intro hands over to the wave card without
   * a cut (the plunge arrives at the follow pose, the card fades in over the
   * moving picture). A skip — or any other exit — jumps the camera, so it dips.
   */
  _introCut(to) {
    return !(to === 'transition' && this.game.director?.introSkipped === false);
  }

  update() {
    const g = this.game;
    const rdt = g.time.realDt;
    // HUD projections need this frame's camera matrices (the rig has moved
    // the camera; the renderer only refreshes them inside render()).
    g.camera.updateMatrixWorld();

    // A wave restarted from inside another card (debug/scripted flows) → refresh.
    if (g.state === 'transition' && g.director && this.card.index !== g.director.waveIndex) {
      this.card.show(g.director.waveIndex);
    }

    this.hud.update(rdt);
    this.subs.update(rdt);
    this.letterbox.update(rdt);
    this.controls.update(rdt);
    this.notices.update(rdt);
    this.title.update(rdt);
    this.pause.update(rdt);
    this.death.update(rdt);
    this.victory.update(rdt);
  }
}
