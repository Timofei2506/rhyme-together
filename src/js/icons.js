/** RHYME TOGETHER — встроенные SVG-иконки (без внешних шрифтов и CDN). */
const P = {
  mic: '<path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
  micOff: '<path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-4.5 2.6"/><path d="M5 11a7 7 0 0 0 11 5.5"/><path d="M12 18v3"/><path d="M4 4l16 16"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h6v18H6a2 2 0 0 1-2-2z"/><path d="M20 5a2 2 0 0 0-2-2h-6v18h6a2 2 0 0 0 2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  keypad: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9h.01M12 9h.01M16 9h.01M8 14h.01M12 14h.01M16 14h.01"/>',
  music: '<circle cx="7" cy="18" r="3"/><circle cx="18" cy="16" r="3"/><path d="M10 18V6l11-2v12"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  link: '<path d="M10 13a4 4 0 0 0 6 0l2-2a4 4 0 0 0-6-6l-1 1"/><path d="M14 11a4 4 0 0 0-6 0l-2 2a4 4 0 0 0 6 6l1-1"/>',
  share: '<path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  signal: '<path d="M4 18v-4M9 18v-8M14 18v-12M19 18V4"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.4"/><circle cx="15" cy="15" r="1.4"/><circle cx="15" cy="9" r="1.4"/><circle cx="9" cy="15" r="1.4"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  speaker: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9a4 4 0 0 1 0 6"/>',
  headphones: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><path d="M4 14h3v6H5a1 1 0 0 1-1-1z"/><path d="M20 14h-3v6h2a1 1 0 0 0 1-1z"/>',
  wifi: '<path d="M3 9a15 15 0 0 1 18 0"/><path d="M6.5 12.5a10 10 0 0 1 11 0"/><path d="M10 16a5 5 0 0 1 4 0"/><circle cx="12" cy="19" r="1"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5a3 3 0 0 1 0 6"/><path d="M18 20a6 6 0 0 0-3-5"/>',
  sparkle: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
};

export function icon(name, size = 18, cls = '') {
  const body = P[name] || '';
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${body}</svg>`;
}

/** Заменяет <span data-icon="mic"></span> на встроенный SVG. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    const size = Number(el.dataset.iconSize || 18);
    el.outerHTML = icon(name, size, el.className || '');
  });
}
export default icon;
