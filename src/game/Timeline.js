// A tiny cue scheduler used by the Director to script the game flow (intro,
// wave cards, post-wave breathers, death beats, victory).
//
// Exactly one script runs at a time: starting a new one (or stop()) cancels
// whatever was running. A cue may itself start another script — the loop
// detects that through the generation counter and stops firing stale cues.

export class Timeline {
  constructor() {
    this.name = null; // name of the running script, null when idle
    this.time = 0; // seconds since the running script started
    this._cues = [];
    this._next = 0;
    this._gen = 0;
  }

  get active() {
    return this.name !== null;
  }

  /**
   * @param {string} name   label (exposed as `timeline.name` for UI/debugging)
   * @param {Array<[number, Function]>} cues  [time, fn] pairs (any order)
   */
  run(name, cues) {
    this._gen++;
    this.name = name;
    this.time = 0;
    this._cues = cues.slice().sort((a, b) => a[0] - b[0]);
    this._next = 0;
  }

  stop() {
    this._gen++;
    this.name = null;
    this._cues = [];
    this._next = 0;
  }

  update(dt) {
    if (this.name === null) return;
    this.time += dt;
    const gen = this._gen;
    while (gen === this._gen && this._next < this._cues.length && this._cues[this._next][0] <= this.time) {
      const fn = this._cues[this._next++][1];
      try {
        fn();
      } catch (err) {
        // One failing cue (e.g. a half-implemented module during integration)
        // must not freeze the flow — log it and keep going.
        console.error(`[Director] cue in "${this.name}" threw`, err);
      }
    }
    if (gen === this._gen && this._next >= this._cues.length) this.stop();
  }
}
