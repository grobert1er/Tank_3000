// Deterministic Mulberry32 PRNG for synchronized online/LAN matches

export class RNG {
  constructor(seed = Date.now()) {
    this.setSeed(seed);
  }

  setSeed(seed) {
    this.state = (Number(seed) >>> 0) || 0x12345678;
  }

  getState() {
    return this.state >>> 0;
  }

  setState(state) {
    this.state = (Number(state) >>> 0) || 0x12345678;
  }

  nextFloat() {
    let t = (this.state += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Returns a deterministic integer in [0, n - 1]
  random(n) {
    const k = Math.floor(n);
    if (k <= 0) return 0;
    return Math.floor(this.nextFloat() * k);
  }
}
