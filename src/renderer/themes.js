'use strict';
// Colour themes. Shared by the app window (and the tests).

const THEMES = {
  crimson: { name: 'Crimson', acc: '#ff3b3b', acc2: '#ff6b6b', chip: '#2a1316', chipb: '#5c2025', on: '#1a0506',
    bg: '#0b0a0e', side: '#121016', panel: '#16141b', line: '#2a2731', text: '#f2eef0', mute: '#a8a3ae', well: '#0d0c10', thumb: '#2b2830' },
  ice: { name: 'Ice', acc: '#3be3ff', acc2: '#7aeeff', chip: '#0f2328', chipb: '#1f4f59', on: '#031a1f',
    bg: '#090c10', side: '#0e1218', panel: '#131820', line: '#232b36', text: '#eef3f7', mute: '#9fabb8', well: '#0b0f14', thumb: '#26303b' },
  toxic: { name: 'Toxic', acc: '#9dff2e', acc2: '#b9ff6a', chip: '#1a2410', chipb: '#3d5c1c', on: '#0d1a02',
    bg: '#0a0c09', side: '#10130e', panel: '#151a12', line: '#262d21', text: '#eef3ea', mute: '#a3ad9c', well: '#0c0f0a', thumb: '#2a3125' },
  amber: { name: 'Amber', acc: '#ffb020', acc2: '#ffc75c', chip: '#2a1f0d', chipb: '#5c4416', on: '#1f1300',
    bg: '#0d0b08', side: '#13100c', panel: '#1a1611', line: '#2e271e', text: '#f5f0e8', mute: '#b0a696', well: '#0f0d0a', thumb: '#302a22' },
  violet: { name: 'Violet', acc: '#b46bff', acc2: '#c995ff', chip: '#211530', chipb: '#48306b', on: '#14061f',
    bg: '#0c0a10', side: '#120f18', panel: '#18141f', line: '#2b2535', text: '#f2eef7', mute: '#aaa2b6', well: '#0e0c12', thumb: '#2e2838' },
  daylight: { name: 'Daylight', acc: '#e0282e', acc2: '#c41f25', chip: '#fde8e8', chipb: '#f2b8ba', on: '#ffffff',
    bg: '#f4f2f5', side: '#ffffff', panel: '#ffffff', line: '#e2dee6', text: '#18151b', mute: '#5f5966', well: '#f7f5f9', thumb: '#dcd8e0' }
};

function hexToRgb(hex) {
  const m = String(hex).trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// A custom theme built from one accent colour on the dark base.
function customTheme(accent) {
  const acc = hexToRgb(accent) ? (accent.startsWith('#') ? accent : '#' + accent) : '#ff3b3b';
  const base = THEMES.crimson;
  const light = luminance(acc) > 0.35;
  return {
    ...base,
    name: 'Custom',
    acc,
    acc2: mix(acc, '#ffffff', 0.25),
    chip: mix(base.bg, acc, 0.14),
    chipb: mix(base.bg, acc, 0.35),
    on: light ? mix(acc, '#000000', 0.88) : '#ffffff'
  };
}

function themeVars(key, customAccent) {
  const t = key === 'custom' ? customTheme(customAccent || '#ff3b3b') : (THEMES[key] || THEMES.crimson);
  return t;
}

if (typeof module !== 'undefined') module.exports = { THEMES, customTheme, themeVars, luminance, mix, hexToRgb };
if (typeof window !== 'undefined') window.SlimThemes = { THEMES, customTheme, themeVars };
