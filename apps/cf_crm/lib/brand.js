/**
 * A customer's branding. The app paints itself with it: the colours become
 * the page's CSS variables, the logo is shown as an <img> (never inlined, so
 * an uploaded SVG cannot run script), and the names replace "NorthEast
 * Network" wherever the app says its own name.
 *
 * Only these keys are kept; colours must be #RRGGBB; the logo must be a data:
 * URL of a PNG, JPEG, WebP or SVG image, at most 300 KB.
 */

// colour key -> the CSS variable it sets (see public/cf_crm/app.css :root)
export const COLOR_VARS = {
  bg: '--bg', surface: '--surface', surface2: '--surface-2', ink: '--ink', muted: '--muted', line: '--line',
  accent: '--accent', accent2: '--accent-2', accentSoft: '--accent-soft', accentInk: '--accent-ink', brandInk: '--brand-ink',
  gold: '--gold', gold2: '--gold-2', goldSoft: '--gold-soft', goldInk: '--gold-ink',
};
const HEX = /^#[0-9a-fA-F]{6}$/;
const LOGO = /^data:image\/(png|jpeg|webp|svg\+xml)(;charset=utf-8)?(;base64)?,[A-Za-z0-9+/=%._~!$&'()*,;:@\-]+$/;
const MAX_LOGO = 300 * 1024;

const text = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function colors(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const k of Object.keys(COLOR_VARS)) if (typeof v[k] === 'string' && HEX.test(v[k])) out[k] = v[k].toUpperCase();
  return out;
}

export function sanitizeBrand(b) {
  b = b && typeof b === 'object' ? b : {};
  const out = {
    appName: text(b.appName, 60),
    shortName: text(b.shortName, 30),
    wordmark: {
      a: text(b.wordmark && b.wordmark.a, 24),
      b: text(b.wordmark && b.wordmark.b, 24),
      sub: text(b.wordmark && b.wordmark.sub, 30),
    },
    colors: colors(b.colors),
    dark: colors(b.dark),
  };
  if (typeof b.logo === 'string' && b.logo && b.logo.length <= MAX_LOGO && LOGO.test(b.logo)) out.logo = b.logo;
  return out;
}

/** NorthEast Network's own look, exactly as the app shipped. */
const NE_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#0A7E98"/><stop offset="1" stop-color="#17AEB0"/></linearGradient></defs><circle cx="50" cy="50" r="50" fill="url(#g)"/><path d="M86 16 18 49.5 40.5 61Z" fill="#FFD60A"/><path d="M86 16 40.5 61 52.5 82Z" fill="#D9AE00"/></svg>';
export const NORTHEAST_BRAND = sanitizeBrand({
  appName: 'NorthEast Network',
  shortName: 'NorthEast',
  wordmark: { a: 'north', b: 'east', sub: 'Network' },
  logo: 'data:image/svg+xml;base64,' + Buffer.from(NE_LOGO_SVG).toString('base64'),
  colors: {
    bg: '#EFF6F9', surface: '#FFFFFF', surface2: '#E3F0F5', ink: '#0D2A33', muted: '#4A6873', line: '#D2E3EA',
    accent: '#08809A', accent2: '#0B97B0', accentSoft: '#D8EEF4', accentInk: '#FFFFFF', brandInk: '#0B6B80',
    gold: '#FFD60A', gold2: '#D9AE00', goldSoft: '#FFF5C2', goldInk: '#3D3100',
  },
  dark: {
    bg: '#08171D', surface: '#0E2229', surface2: '#143039', ink: '#E2F0F4', muted: '#93B1BA', line: '#1E3D47',
    accent: '#3CC0D6', accent2: '#62D0E2', accentSoft: '#103A45', accentInk: '#04191F', brandInk: '#6FD3E3',
    gold: '#FFD60A', gold2: '#E3B800', goldSoft: '#3A3209', goldInk: '#FFE873',
  },
});
