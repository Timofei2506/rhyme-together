/**
 * RHYME TOGETHER — сетевой клиент.
 *
 *  • WebSocket с автоматическим переподключением (экспоненциальная пауза);
 *  • ресинхронизация часов по серверу (NTP-подобный ping/pong, медиана);
 *  • буферизация сообщений до восстановления соединения.
 */
import { resolveEndpoints } from '../js/config.js';

export class GameSocket extends EventTarget {
  constructor(wsUrl = null) {
    super();
    this.ws = null;
    this.url = wsUrl || resolveEndpoints().wsUrl;
    this.sessionId = localStorage.getItem('rt.sessionId') || null;
    this.name = localStorage.getItem('rt.name') || '';
    this.code = null;
    this.attempt = 0;
    this.connected = false;
    this.intentionalClose = false;
    this.queue = [];
    this.clock = { offset: 0, rtt: 0, samples: [], synced: false, quality: 0 };
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastPongAt = 0;
  }

  // ── подключение ────────────────────────────────────────────────────────────
  connect() {
    this.intentionalClose = false;
    this._setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.attempt = 0;
      this._setStatus('connected');
      // синхронизация часов: 5 замеров, берём лучший
      this.syncClock(5);
      // восстановление сессии, если были в комнате
      const resumeCode = sessionStorage.getItem('rt.resumeCode');
      if (resumeCode) {
        this.send('join', { code: resumeCode, sessionId: this.sessionId, name: this.name, resume: true });
      }
      while (this.queue.length) {
        const m = this.queue.shift();
        this._raw(m);
      }
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'time') { this._onTime(msg); return; }
      if (msg.type === 'joined') {
        this.code = msg.code;
        this.sessionId = msg.sessionId;
        localStorage.setItem('rt.sessionId', msg.sessionId);
        sessionStorage.setItem('rt.resumeCode', msg.code);
      }
      this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
      this.dispatchEvent(new CustomEvent('*', { detail: msg }));
    };

    ws.onclose = () => {
      this.connected = false;
      this._setStatus('disconnected');
      this._stopPing();
      if (!this.intentionalClose) this._scheduleReconnect();
    };
    ws.onerror = () => {
      this._emit('neterror', { message: 'Ошибка сетевого соединения' });
    };
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.attempt++;
    const delay = Math.min(12000, 400 * Math.pow(1.7, Math.min(this.attempt, 7)));
    this._emit('reconnecting', { attempt: this.attempt, delay });
    this.reconnectTimer = setTimeout(() => {
      this._emit('reconnect-attempt', { attempt: this.attempt });
      this.connect();
    }, delay);
  }

  disconnect() {
    this.intentionalClose = true;
    clearTimeout(this.reconnectTimer);
    this._stopPing();
    try { this.ws?.close(); } catch {}
  }

  clearResume() { sessionStorage.removeItem('rt.resumeCode'); this.code = null; }

  // ── отправка ───────────────────────────────────────────────────────────────
  _raw(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    return true;
  }
  send(type, data = {}) {
    const msg = { type, ...data };
    if (!this.connected) {
      if (['create', 'join'].includes(type)) this.queue.push(msg);
      return false;
    }
    return this._raw(msg);
  }

  // ── часы ───────────────────────────────────────────────────────────────────
  syncClock(samples = 3) {
    let done = 0;
    const go = () => {
      if (done++ >= samples) return;
      setTimeout(go, 120);
      this._raw({ type: 'time', t0: Date.now() });
    };
    go();
    this._startPing();
  }

  _onTime(msg) {
    const t3 = Date.now();
    const rtt = t3 - msg.t0;
    const offset = msg.t1 - (msg.t0 + rtt / 2);
    this.lastPongAt = t3;
    if (rtt > 2000) return; // отбрасываем выбросы
    this.clock.samples.push({ offset, rtt });
    if (this.clock.samples.length > 9) this.clock.samples.shift();
    // берём замер с минимальным RTT — он точнее всего
    const best = this.clock.samples.reduce((a, b) => (a.rtt <= b.rtt ? a : b));
    this.clock.offset = best.offset;
    this.clock.rtt = best.rtt;
    this.clock.synced = true;
    this.clock.quality = Math.max(0, 1 - Math.min(1, best.rtt / 400));
    this._emit('clock', { ...this.clock, samples: undefined });
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastPongAt > 4000) this._raw({ type: 'time', t0: Date.now() });
      else if (this.clock.samples.length < 9) this._raw({ type: 'time', t0: Date.now() });
    }, 3000);
  }
  _stopPing() { clearInterval(this.pingTimer); }

  /** Серверное «сейчас» по локальным часам */
  serverNow() { return Date.now() + this.clock.offset; }

  // ── события ────────────────────────────────────────────────────────────────
  on(type, fn) {
    const h = (e) => fn(e.detail);
    this.addEventListener(type, h);
    return () => this.removeEventListener(type, h);
  }
  _emit(type, data) { this.dispatchEvent(new CustomEvent(type, { detail: data })); }
  _setStatus(status) {
    this.status = status;
    this._emit('status', { status, connected: this.connected });
  }
}
