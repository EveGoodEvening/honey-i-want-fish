// Victory: 3 s of the clean payoff shot, then 「老婆，开饭了！」, the run's
// numbers and 「再来一次」 (timings in the .fish-victory CSS).
import { h, replay, reloadWith, fmtTime, fmtInt, charSpans } from '../dom.js';
import { Menu } from '../Menu.js';

const STAT_ROWS = [
  ['time', '用时', (s) => fmtTime(s.time)],
  ['damage', '造成伤害', (s) => fmtInt(s.damage)],
  ['parries', '格挡', (s) => fmtInt(s.parries)],
  ['perfectDodges', '完美闪避', (s) => fmtInt(s.perfectDodges)],
  ['grabsEscaped', '挣脱', (s) => (s.grabs ? `${fmtInt(s.grabsEscaped)}<small> / ${fmtInt(s.grabs)}</small>` : '0')],
  ['deaths', '倒下', (s) => fmtInt(s.deaths)],
];

export class VictoryScreen {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.stats = null;
    const el = (this.el = h('section', 'fish-screen fish-victory'));
    el.innerHTML = `
      <div class="fish-victory__bg"></div>
      <div class="fish-victory__inner">
        <div class="fish-kicker fish-victory__kicker"><i></i><span>今晚吃鱼 · 明天也吃鱼</span><i></i></div>
        <h2 class="fish-victory__title">${charSpans('老婆，开饭了！')}</h2>
        <div class="fish-victory__rule"></div>
        <dl class="fish-victory__stats">
          ${STAT_ROWS.map(([key, label], i) => `
            <div class="fish-victory__row" style="--i:${i}"><dt>${label}</dt><dd data-stat="${key}">—</dd></div>`).join('')}
        </dl>
        <nav class="fish-victory__menu">
          <button class="fish-btn fish-btn--primary" data-act="again">再来一次</button>
          <button class="fish-btn fish-btn--small" data-act="title">回到标题</button>
        </nav>
      </div>`;
    this.cells = {};
    for (const [key] of STAT_ROWS) this.cells[key] = el.querySelector(`[data-stat="${key}"]`);

    // Armed once the menu has risen in (5.6 s, see the .fish-victory CSS delays).
    this.menu = new Menu(this.game, { armDelay: 5.4 });
    this.menu.add(el.querySelector('[data-act="again"]'), () => this.ui.playAgain());
    this.menu.add(el.querySelector('[data-act="title"]'), () => reloadWith({ autostart: null, wave: null }));

    this.game.events.on('game:victory', ({ stats } = {}) => this.setStats(stats));
  }

  setStats(stats) {
    this.stats = stats ?? this.game.director?.stats?.snapshot?.() ?? null;
    if (!this.stats) return;
    for (const [key, , fmt] of STAT_ROWS) this.cells[key].innerHTML = fmt(this.stats);
  }

  show() {
    if (!this.stats) this.setStats(null);
    this.el.classList.add('is-on');
    replay(this.el);
    this.menu.open(0);
  }

  hide() {
    this.el.classList.remove('is-on');
    this.menu.close();
    this.stats = null;
  }

  update(rdt) {
    this.menu.update(rdt);
  }
}
