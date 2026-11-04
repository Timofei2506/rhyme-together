/**
 * RHYME TOGETHER — конфигурация подключения.
 *
 * По умолчанию клиент работает с тем же origin (фронтенд и игровой сервер
 * в одном процессе). Если фронтенд развёрнут отдельно (например, на Vercel),
 * адрес игрового сервера задаётся одним из способов:
 *   1) ?ws=wss://rhyme-api.example.com/ws&api=https://rhyme-api.example.com
 *   2) localStorage: rt.wsUrl / rt.apiBase
 *   3) window.RT_WS_URL / window.RT_API_URL (можно задать в index.html)
 */
export function resolveEndpoints() {
  const q = new URLSearchParams(location.search);
  const ls = {
    ws: () => localStorage.getItem('rt.wsUrl'),
    api: () => localStorage.getItem('rt.apiBase'),
  };
  let wsUrl = q.get('ws') || ls.ws() || window.RT_WS_URL || null;
  let apiBase = q.get('api') || ls.api() || window.RT_API_URL || null;

  // запоминаем переопределение, чтобы пережить перезагрузку
  if (q.get('ws')) localStorage.setItem('rt.wsUrl', q.get('ws'));
  if (q.get('api')) localStorage.setItem('rt.apiBase', q.get('api'));

  if (!wsUrl) {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    wsUrl = proto + location.host + '/ws';
  }
  // из ws-адреса можно вывести api, если он не задан
  if (!apiBase && (q.get('ws') || localStorage.getItem('rt.wsUrl'))) {
    try {
      const u = new URL(wsUrl);
      apiBase = u.origin;
    } catch { apiBase = null; }
  }
  return { wsUrl, apiBase: apiBase || '' };
}

/** Собирает URL API с учётом внешнего бэкенда. */
export function apiUrl(path, apiBase = '') {
  if (!apiBase) return path;
  return apiBase.replace(/\/$/, '') + path;
}

/** Сброс переопределений (кнопка «Сбросить сессию») */
export function clearEndpointOverrides() {
  localStorage.removeItem('rt.wsUrl');
  localStorage.removeItem('rt.apiBase');
}
