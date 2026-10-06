// Run statistics shown on the victory screen. Owned by the Director, which
// feeds it from gameplay events; the UI only reads `snapshot()`.

export class PlayStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.time = 0; // seconds spent in 'playing' (real time, pauses excluded)
    this.damage = 0; // total damage dealt to enemies
    this.hits = 0; // knife hits that connected
    this.criticals = 0; // hits on eye / gills
    this.parries = 0;
    this.perfectDodges = 0;
    this.grabs = 0; // times caught in jaws
    this.grabsEscaped = 0; // ...and stabbed free
    this.deaths = 0;
    this.damageTaken = 0;
    this.kills = 0;
  }

  snapshot() {
    return {
      time: this.time,
      damage: Math.round(this.damage),
      hits: this.hits,
      criticals: this.criticals,
      parries: this.parries,
      perfectDodges: this.perfectDodges,
      grabs: this.grabs,
      grabsEscaped: this.grabsEscaped,
      deaths: this.deaths,
      damageTaken: Math.round(this.damageTaken),
      kills: this.kills,
    };
  }
}
