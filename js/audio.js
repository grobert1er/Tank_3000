// Web Audio API sound effects manager

export class SoundManager {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.rawArrayBuffers = new Map();
    this.muted = false;
    this.loaded = false;
    this._lastPlayTime = new Map();
    this._activeSources = new Map();
  }

  async loadAll(soundMap) {
    const entries = Object.entries(soundMap);
    await Promise.all(
      entries.map(async ([idStr, info]) => {
        const id = Number(idStr);
        try {
          const resp = await fetch(info.file);
          if (!resp.ok) return;
          const ab = await resp.arrayBuffer();
          this.rawArrayBuffers.set(id, ab);
        } catch (err) {
          console.warn('Sound fetch failed:', id, err);
        }
      })
    );
    this.loaded = true;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this._decodePending();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  async _decodePending() {
    if (!this.ctx) return;
    for (const [id, raw] of this.rawArrayBuffers.entries()) {
      if (this.buffers.has(id)) continue;
      try {
        const copy = raw.slice(0);
        const audioBuf = await this.ctx.decodeAudioData(copy);
        this.buffers.set(id, audioBuf);
      } catch (err) {
        console.warn('Audio decode failed:', id, err);
      }
    }
  }

  setMuted(m) {
    this.muted = Boolean(m);
    if (this.muted) this.stopAll();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.muted) this.stopAll();
    return this.muted;
  }

  isPlaying(soundId) {
    const set = this._activeSources.get(soundId);
    return Boolean(set && set.size > 0);
  }

  stop(soundId) {
    const set = this._activeSources.get(soundId);
    if (!set) return;
    for (const src of set) {
      try { src.stop(); } catch {}
    }
    set.clear();
  }

  stopAll() {
    for (const sid of this._activeSources.keys()) {
      this.stop(sid);
    }
  }

  play(soundId, { volume = 0.85, minIntervalMs = 35, noMultiple = false } = {}) {
    if (this.muted) return;
    if (!this.ctx) this.unlock();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    if (noMultiple && this.isPlaying(soundId)) return;

    const now = performance.now();
    const last = this._lastPlayTime.get(soundId) || 0;
    if (now - last < minIntervalMs) return;

    const buf = this.buffers.get(soundId);
    if (!buf) {
      if (this.rawArrayBuffers.has(soundId)) {
        this._decodePending();
      }
      return;
    }

    this._lastPlayTime.set(soundId, now);
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      src.connect(gain);
      gain.connect(this.ctx.destination);

      let set = this._activeSources.get(soundId);
      if (!set) {
        set = new Set();
        this._activeSources.set(soundId, set);
      }
      set.add(src);
      src.onended = () => {
        set.delete(src);
      };

      src.start(0);
    } catch {
      // ignore playback error
    }
  }
}
