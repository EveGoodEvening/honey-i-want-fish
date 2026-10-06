// Small DOM helpers shared by the UI components. Nothing here runs per frame
// except the cheap write-if-changed helpers.

/** createElement + className + innerHTML in one call. */
export function h(tag, className = '', html = null) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (html !== null) el.innerHTML = html;
  return el;
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Exponential smoothing factor for a rate (1/s) over dt. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

/** Round to 3 decimals so we only touch the DOM when a value visibly changes. */
export const q3 = (v) => Math.round(v * 1000) / 1000;

/** Split a string into per-character spans (for staggered reveals). */
export function charSpans(text, className = 'ch') {
  let html = '';
  let i = 0;
  for (const ch of text) {
    let cls = className;
    let glyph = ch;
    if (ch === '，' || ch === '、') {
      cls += ' is-punct is-comma';
      glyph = ','; // see .is-comma in ui.css
    } else if (ch === '。') {
      cls += ' is-punct is-stop';
    } else if (/[！？：；…「」]/.test(ch)) {
      cls += ' is-punct';
    }
    html += `<span class="${cls}" style="--i:${i}">${glyph}</span>`;
    i++;
  }
  return html;
}

/** Restart CSS animations that are keyed on `className` (default 'is-play'). */
export function replay(el, className = 'is-play') {
  el.classList.remove(className);
  void el.offsetWidth; // force style flush so the animation restarts
  el.classList.add(className);
}

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function fmtInt(n) {
  return Math.round(n || 0).toLocaleString('en-US');
}

/** Navigate to the current URL with some params changed (null deletes). */
export function reloadWith(changes) {
  const url = new URL(location.href);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined) url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  // URLSearchParams writes flags as `autostart=`; keep the URL tidy.
  location.href = url.toString().replace(/=(?=&|$)/g, '');
}

/** A tileable monochrome noise texture as a data URL, for film grain. */
export function makeNoiseDataURL(size = 160) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  } catch {
    return '';
  }
}

/** True when running under automation (Playwright etc.) — used to hide hints that only make sense for humans. */
export const isAutomated = typeof navigator !== 'undefined' && !!navigator.webdriver;
