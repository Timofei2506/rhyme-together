/**
 * RHYME TOGETHER — голосовая связь на WebRTC.
 *
 *  • собственный RTCPeerConnection, полностью независимый от музыки;
 *  • STUN/TURN берутся с сервера (/api/rtc-config);
 *  • роль инициатора (оффер) — у игрока, вошедшего первым;
 *  • регулировка громкости собеседника через GainNode;
 *  • индикация уровня микрофона и «говорит сейчас» собеседника;
 *  • авто-восстановление ICE при обрыве (restartIce) и при переподключении WS.
 */
export class VoiceLink extends EventTarget {
  constructor(socket, opts = {}) {
    super();
    this.socket = socket;
    this.rtcConfig = opts.rtcConfig || { iceServers: [] };
    this.localStream = null;
    this.pc = null;
    this.analyser = null;
    this.micGain = opts.micGain ?? 1;
    this.peerVolume = opts.peerVolume ?? 1;
    this.muted = false;
    this.micEnabled = false;
    this.peerSessionId = null;
    this.isInitiator = false;
    this.peerAudioEl = null;
    this.remoteStream = null;
    this.stats = { rtt: null, jitter: null, packetsLost: 0, bitrate: 0, codec: null, type: null };
    this._meterRAF = null;
    this._lastBytes = 0;
    this._lastStatsAt = 0;
    this.level = 0;
    this.peerLevel = 0;
    this.connectedAt = null;
    this.iceState = 'new';
  }

  // ── микрофон ───────────────────────────────────────────────────────────────
  async ensureMic(deviceId) {
    if (this.localStream) return this.localStream;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Микрофон недоступен: нужен HTTPS или localhost');
    }
    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    };
    this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    this._attachMeter();
    this.micEnabled = true;
    return this.localStream;
  }

  async listDevices() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter(d => d.kind === 'audioinput');
    } catch { return []; }
  }

  setMuted(muted) {
    this.muted = muted;
    this.localStream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
    this._emit('mic', { muted, on: this.micEnabled && !muted });
  }

  setMicGain(v) {
    this.micGain = v;
    if (this._micGainNode) this._micGainNode.gain.value = v;
  }

  setPeerVolume(v) {
    this.peerVolume = v;
    if (this._peerGain) this._peerGain.gain.setTargetAtTime(v, this._ctx?.currentTime || 0, 0.03);
    if (this.peerAudioEl) this.peerAudioEl.volume = Math.min(1, v);
  }

  _attachMeter() {
    try {
      this._ctx = this._ctx || new (window.AudioContext || window.webkitAudioContext)();
      const src = this._ctx.createMediaStreamSource(this.localStream);
      this._micGainNode = this._ctx.createGain();
      this._micGainNode.gain.value = this.micGain;
      this.analyser = this._ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.55;
      src.connect(this._micGainNode).connect(this.analyser);
      this._buf = new Float32Array(this.analyser.fftSize);
      if (this._ctx.state === 'suspended') this._ctx.resume();
    } catch (e) { console.warn('[voice] meter:', e.message); }
  }

  /** Уровень своего микрофона 0..1 (RMS) */
  readMicLevel() {
    if (!this.analyser || !this.localStream) return 0;
    this.analyser.getFloatTimeDomainData(this._buf);
    let s = 0;
    for (let i = 0; i < this._buf.length; i++) s += this._buf[i] * this._buf[i];
    const rms = Math.sqrt(s / this._buf.length);
    const db = 20 * Math.log10(rms || 1e-6);
    // -60 дБ → 0, -6 дБ → 1
    const norm = Math.max(0, Math.min(1, (db + 60) / 54));
    this.level = this.level * 0.6 + norm * 0.4;
    return this.level;
  }

  // ── соединение ─────────────────────────────────────────────────────────────
  async createPeer(initiator, peerSessionId) {
    this.closePeer();
    this.peerSessionId = peerSessionId;
    this.isInitiator = initiator;
    this.pc = new RTCPeerConnection({
      iceServers: this.rtcConfig.iceServers || [],
      iceTransportPolicy: this.rtcConfig.iceTransportPolicy || 'all',
      bundlePolicy: 'max-bundle',
    });
    this._setupPcListeners();

    // локальные треки
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        this.pc.addTrack(track, this.localStream);
      }
    } else {
      this.pc.addTransceiver('audio', { direction: 'sendrecv' });
    }
    this.pc.getTransceivers().forEach(tr => {
      // понижаем битрейт — голосу хватает 32 кбит/с, задержка меньше
      try {
        const cap = tr.sender.getParameters?.();
        if (cap?.encodings?.length) {
          cap.encodings[0].maxBitrate = 32000;
          cap.encodings[0].networkPriority = 'high';
          tr.sender.setParameters(cap).catch(() => {});
        }
      } catch {}
    });
    this._emit('pc', { state: 'created', initiator });
    return this.pc;
  }

  _setupPcListeners() {
    const pc = this.pc;
    pc.onicecandidate = (e) => {
      if (e.candidate) this.socket.send('rtc-ice', { candidate: e.candidate.toJSON() });
    };
    pc.oniceconnectionstatechange = () => {
      this.iceState = pc.iceConnectionState;
      this._emit('ice', { state: pc.iceConnectionState });
    };
    pc.onconnectionstatechange = () => {
      this._emit('pc', { state: pc.connectionState });
      if (pc.connectionState === 'connected' && !this.connectedAt) this.connectedAt = Date.now();
      if (pc.connectionState === 'failed') {
        this._emit('pc-failed', {});
        this.restartIce();
      }
    };
    pc.ontrack = (e) => {
      const [stream] = e.streams;
      this.remoteStream = stream;
      if (!this.peerAudioEl) {
        this.peerAudioEl = new Audio();
        this.peerAudioEl.autoplay = true;
        this.peerAudioEl.playsInline = true;
        this.peerAudioEl.setAttribute('playsinline', '');
      }
      this.peerAudioEl.srcObject = stream;
      this.peerAudioEl.volume = Math.min(1, this.peerVolume);
      this.peerAudioEl.play().catch(() => this._emit('audio-blocked', {}));
      this._attachPeerMeter(stream);
      this._startStats();
      this._emit('track', { stream });
    };
  }

  _attachPeerMeter(stream) {
    try {
      const ctx = (this._ctx = this._ctx || new (window.AudioContext || window.webkitAudioContext)());
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      an.smoothingTimeConstant = 0.6;
      src.connect(an);
      this._peerAnalyser = an;
      this._peerBuf = new Float32Array(an.fftSize);
    } catch (e) { console.warn('[voice] peer meter:', e.message); }
  }

  readPeerLevel() {
    if (!this._peerAnalyser) return 0;
    this._peerAnalyser.getFloatTimeDomainData(this._peerBuf);
    let s = 0;
    for (let i = 0; i < this._peerBuf.length; i++) s += this._peerBuf[i] * this._peerBuf[i];
    const rms = Math.sqrt(s / this._peerBuf.length);
    const db = 20 * Math.log10(rms || 1e-6);
    const norm = Math.max(0, Math.min(1, (db + 60) / 54));
    this.peerLevel = this.peerLevel * 0.6 + norm * 0.4;
    return this.peerLevel;
  }

  async handleSignal(type, msg) {
    if (!this.pc) {
      // оффер пришёл раньше, чем мы создали peer: создаём как отвечающего
      await this.createPeer(false, msg.from);
    }
    if (type === 'rtc-offer') {
      await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.socket.send('rtc-answer', { sdp: this.pc.localDescription });
    } else if (type === 'rtc-answer') {
      if (this.pc.signalingState === 'have-local-offer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      }
    } else if (type === 'rtc-ice') {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      } catch (e) { /* кандидат мог прийти слишком рано — игнорируем */ }
    } else if (type === 'rtc-renegotiate') {
      await this.makeOffer();
    }
  }

  async makeOffer() {
    if (!this.pc) return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.socket.send('rtc-offer', { sdp: this.pc.localDescription });
  }

  async restartIce() {
    if (!this.pc) return;
    try {
      if (this.isInitiator) {
        this._emit('ice-restart', {});
        await this.makeOffer();
      } else {
        this.socket.send('rtc-renegotiate', {});
      }
    } catch (e) { console.warn('[voice] restartIce:', e.message); }
  }

  _startStats() {
    clearInterval(this._statsTimer);
    this._statsTimer = setInterval(async () => {
      if (!this.pc) return;
      try {
        const report = await this.pc.getStats();
        let inbound = null, remoteInbound = null, pair = null, codec = null;
        report.forEach(r => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio') inbound = r;
          if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') remoteInbound = r;
          if (r.type === 'candidate-pair' && r.state === 'succeeded') pair = r;
          if (r.type === 'codec' && r.mimeType?.startsWith('audio')) codec = r.mimeType;
        });
        const nowT = performance.now();
        if (inbound) {
          const dt = (nowT - this._lastStatsAt) / 1000;
          if (this._lastStatsAt && dt > 0) {
            const dBytes = (inbound.bytesReceived || 0) - (this._lastBytes || 0);
            this.stats.bitrate = Math.round((dBytes * 8) / dt / 1000);
          }
          this._lastBytes = inbound.bytesReceived || 0;
          this._lastStatsAt = nowT;
          this.stats.jitter = inbound.jitter != null ? Math.round(inbound.jitter * 1000 * 10) / 10 : null;
          this.stats.packetsLost = inbound.packetsLost || 0;
          this.stats.type = pair?.localCandidateId ? 'p2p' : this.stats.type;
          if (pair) {
            const lc = report.get(pair.localCandidateId);
            this.stats.type = lc?.candidateType || 'p2p';
          }
        }
        if (remoteInbound?.roundTripTime != null) this.stats.rtt = Math.round(remoteInbound.roundTripTime * 1000);
        if (codec) this.stats.codec = codec;
        this._emit('stats', { ...this.stats });
      } catch {}
    }, 2000);
  }

  closePeer() {
    clearInterval(this._statsTimer);
    try { this.pc?.getSenders().forEach(s => { try { s.track && null; } catch {} }); } catch {}
    if (this.pc && this.localStream) {
      // не останавливаем сам микрофон — он нужен для анализа
      try { this.pc.getSenders().forEach(s => s.replaceTrack && s.replaceTrack(null)); } catch {}
    }
    try { this.pc?.close(); } catch {}
    this.pc = null;
    this.connectedAt = null;
    this._stopStatsAndAudio();
  }

  _stopStatsAndAudio() {
    clearInterval(this._statsTimer);
    if (this.peerAudioEl) { try { this.peerAudioEl.pause(); this.peerAudioEl.srcObject = null; } catch {} }
  }

  destroy() {
    this.closePeer();
    try { this.localStream?.getTracks().forEach(t => t.stop()); } catch {}
    this.localStream = null;
  }

  _emit(type, data) { this.dispatchEvent(new CustomEvent(type, { detail: data })); }
}
