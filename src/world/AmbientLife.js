// AmbientLife — the living ocean around the fight. See docs/DESIGN.md "AmbientLife".
//
//   FishSchools  2-4 instanced schools of small silvery fish (boids-lite) that
//                scatter from sharks, the player and blood, then reform
//   Jellyfish    a few dim, translucent pulsing bells with lagging tentacles,
//                kept >= 15 m from the player
//   SpermWhale   an 18 m mass crossing ~30 m away through the murk after the
//                tiger-shark wave ('wave:clear' index 1) — emits 'ambient:whale'
//
// Helpers live in src/world/ambient/. Everything is procedural.
// Render hook: chains scene.onBeforeRender (never replaces it) so the fish
// schools are culled/packed with the camera that is about to render.
// Shader warm-up: PostFX.warmup() precompiles the whole scene (the hidden
// whale included) against the real HDR render target after the first frame.
// Test hooks: __game.ambient.triggerWhale(), __game.ambient.whale.position,
// __game.ambient.fish.getSchoolCenter(i).
import * as THREE from 'three';
import { FishSchools } from './ambient/FishSchools.js';
import { Jellyfish } from './ambient/Jellyfish.js';
import { SpermWhale } from './ambient/SpermWhale.js';
import { Threats } from './ambient/Threats.js';
import { createOceanEnvMap } from './ambient/oceanEnvMap.js';

export class AmbientLife {
  constructor(game) {
    this.game = game;
    const quality = game.quality ?? 'high';
    this.time = 0;

    this.root = new THREE.Group();
    this.root.name = 'AmbientLife';
    game.scene.add(this.root);

    const water = game.env?.waterColor?.isColor ? game.env.waterColor : new THREE.Color(0x0b3140);
    this.envMap = createOceanEnvMap(water);

    this.threats = new Threats(game);
    this.fish = new FishSchools(game, this.root, { envMap: this.envMap, quality });
    this.jellies = new Jellyfish(game, this.root, { quality });
    this.whale = new SpermWhale(game, this.root, { envMap: this.envMap, quality });

    // Fish schools are culled and packed at render time with the camera
    // actually used (update() runs before the camera rig moves, so culling
    // there would drop a school for a frame after every camera cut). Chained:
    // Environment (and maybe others) hook scene.onBeforeRender too.
    this._disposed = false;
    const prevBefore = game.scene.onBeforeRender;
    const life = this;
    game.scene.onBeforeRender = function onBeforeRender(renderer, scene, camera, target) {
      prevBefore.call(this, renderer, scene, camera, target);
      if (!life._disposed) life.fish.prepareRender(camera);
    };

    const ev = game.events;
    this._off = [
      ev.on('enemy:hit', (p) => {
        const amount = p?.critical ? 1.6 : p?.attackType === 'heavy' ? 1.3 : 0.9;
        this.threats.addBlood(p?.position ?? p?.enemy?.position, amount);
      }),
      ev.on('enemy:death', (p) => this.threats.addBlood(p?.enemy?.position, 2.5)),
      ev.on('player:hit', (p) => this.threats.addBlood(this.game.player?.position, Math.min(2, (p?.damage ?? 10) / 15))),
      ev.on('wave:clear', (p) => {
        if (p?.index === 1) this.triggerWhale();
      }),
    ];
  }

  /** Start the distant sperm-whale pass (also used by tests). */
  triggerWhale() {
    const started = this.whale.start();
    if (started) this.game.events.emit('ambient:whale', { position: this.whale.position });
    return started;
  }

  update(dt) {
    if (!(dt > 0)) return;
    this.time += dt;
    this.threats.update(dt);
    this.fish.update(dt, this.threats, this.time);
    this.jellies.update(dt, this.threats);
    this.whale.update(dt);
  }

  dispose() {
    // the chained render hook can't be unlinked safely (others may have
    // chained after it): it turns into a pass-through
    this._disposed = true;
    for (const off of this._off) off();
    this.fish.dispose();
    this.jellies.dispose();
    this.whale.dispose();
    this.envMap.dispose();
    this.root.removeFromParent();
  }
}
