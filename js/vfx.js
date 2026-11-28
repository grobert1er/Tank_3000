// Clean Paper-Cut Visual Effects Engine (purely cosmetic, never touches deterministic game RNG)
// Handles: shockwave ring explosions, soft smoke trails, floating damage/bounty popups,
// subtle screen shake, and wind-driven ambient weather (snow, drifting leaves, desert motes).

import { STAGE_W, STAGE_H } from './constants.js';

export class VfxManager {
  constructor() {
    this.explosions = []; // { x, y, maxR, frame, maxFrames, coreCol, ringCol }
    this.trails = [];     // { x, y, vx, vy, r, alpha, col, life, maxLife }
    this.sparks = [];     // { x, y, vx, vy, r, col, life, maxLife }
    this.popups = [];     // { x, y, vy, text, color, life, maxLife, scale }
    this.weather = [];    // ambient particles across viewport
    this.weatherKrajina = 0;
    this.shakeFrames = 0;
    this.shakeMag = 0;
  }

  clearBattleFx() {
    this.explosions = [];
    this.trails = [];
    this.sparks = [];
    this.popups = [];
    this.shakeFrames = 0;
    this.shakeMag = 0;
  }

  spawnExplosion(x, y, blastW = 35, kind = 'missile') {
    const maxR = Math.max(12, blastW * 0.56);
    const isHeavy = blastW >= 85;
    const isNuke = blastW >= 150;
    const maxFrames = isNuke ? 22 : isHeavy ? 17 : 13;

    this.explosions.push({
      x,
      y,
      maxR,
      frame: 0,
      maxFrames,
      coreCol: isNuke ? '#fef08a' : '#fde047',
      midCol: isNuke ? '#fb923c' : '#f97316',
      ringCol: isNuke ? '#f97316' : '#fb923c',
    });

    // Subtle debris sparks radiating cleanly outward
    const sparkCount = isNuke ? 14 : isHeavy ? 9 : 5;
    for (let i = 0; i < sparkCount; i++) {
      const ang = (Math.PI * 2 * i) / sparkCount + (Math.random() - 0.5) * 0.45;
      const spd = (isNuke ? 3.2 : isHeavy ? 2.4 : 1.7) * (0.65 + Math.random() * 0.7);
      this.sparks.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 0.8,
        r: isNuke ? 2.4 : 1.7,
        col: i % 2 === 0 ? '#fde047' : '#fb923c',
        life: 0,
        maxLife: 12 + Math.floor(Math.random() * 10),
      });
    }

    // Crisp micro screen shake scaled to blast size
    const mag = isNuke ? 4.2 : isHeavy ? 2.4 : kind === 'death' ? 2.6 : 1.1;
    const dur = isNuke ? 10 : isHeavy ? 7 : 4;
    if (mag >= this.shakeMag || this.shakeFrames <= 0) {
      this.shakeMag = mag;
      this.shakeFrames = Math.max(this.shakeFrames, dur);
    }
  }

  spawnTrail(x, y, isHeavy = false, col = 'rgba(255,255,255,0.68)') {
    this.trails.push({
      x: x + (Math.random() - 0.5) * 1.2,
      y: y + (Math.random() - 0.5) * 1.2,
      vx: (Math.random() - 0.5) * 0.15,
      vy: -0.12 - Math.random() * 0.12,
      r: isHeavy ? 2.8 : 1.9,
      col,
      life: 0,
      maxLife: isHeavy ? 18 : 13,
    });
    if (this.trails.length > 180) {
      this.trails.splice(0, this.trails.length - 180);
    }
  }

  spawnPopup(x, y, text, color = '#ef4444', large = false) {
    // Stagger overlapping popups vertically so simultaneous hits remain readable
    let yOff = 0;
    for (const p of this.popups) {
      if (Math.abs(p.x - x) < 28 && Math.abs(p.y - (y + yOff)) < 12) {
        yOff -= 13;
      }
    }
    this.popups.push({
      x,
      y: y - 14 + yOff,
      vy: -0.58,
      text: String(text),
      color,
      life: 0,
      maxLife: large ? 46 : 34,
      large,
    });
  }

  _ensureWeather(krajina, viewBounds) {
    const left = viewBounds ? viewBounds.left : -120;
    const right = viewBounds ? viewBounds.right : STAGE_W + 120;
    const top = viewBounds ? viewBounds.top : -40;
    const bottom = viewBounds ? viewBounds.bottom : STAGE_H + 40;
    const targetCount = krajina === 1 ? 36 : krajina === 2 ? 20 : 24;

    if (this.weatherKrajina !== krajina) {
      this.weatherKrajina = krajina;
      this.weather = [];
    }

    while (this.weather.length < targetCount) {
      this.weather.push({
        x: left + Math.random() * (right - left),
        y: top + Math.random() * (bottom - top),
        size: krajina === 1 ? (1.1 + Math.random() * 1.6) : krajina === 2 ? (2.0 + Math.random() * 1.8) : (1.0 + Math.random() * 1.3),
        speedY: krajina === 1 ? (0.32 + Math.random() * 0.45) : krajina === 2 ? (0.25 + Math.random() * 0.35) : (0.12 + Math.random() * 0.25),
        phase: Math.random() * Math.PI * 2,
        rot: Math.random() * Math.PI * 2,
        alpha: krajina === 1 ? (0.42 + Math.random() * 0.42) : (0.3 + Math.random() * 0.38),
      });
    }
  }

  tick(krajina = 1, vitr = 0, viewBounds = null) {
    // Screen shake decay
    if (this.shakeFrames > 0) {
      this.shakeFrames--;
      if (this.shakeFrames <= 0) this.shakeMag = 0;
    }

    // Shockwave explosions
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.frame++;
      if (e.frame >= e.maxFrames) this.explosions.splice(i, 1);
    }

    // Smoke trails
    for (let i = this.trails.length - 1; i >= 0; i--) {
      const tr = this.trails[i];
      tr.x += tr.vx + vitr * 0.004;
      tr.y += tr.vy;
      tr.r += 0.1;
      tr.life++;
      if (tr.life >= tr.maxLife) this.trails.splice(i, 1);
    }

    // Debris sparks
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const sp = this.sparks[i];
      sp.x += sp.vx;
      sp.y += sp.vy;
      sp.vy += 0.14;
      sp.life++;
      if (sp.life >= sp.maxLife) this.sparks.splice(i, 1);
    }

    // Floating damage/bounty popups
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.y += p.vy;
      p.vy *= 0.96;
      p.life++;
      if (p.life >= p.maxLife) this.popups.splice(i, 1);
    }

    // Wind-driven ambient weather
    this._ensureWeather(krajina, viewBounds);
    const left = (viewBounds ? viewBounds.left : -120) - 20;
    const right = (viewBounds ? viewBounds.right : STAGE_W + 120) + 20;
    const top = (viewBounds ? viewBounds.top : -40) - 10;
    const bottom = (viewBounds ? viewBounds.bottom : STAGE_H + 40) + 10;
    const windDrift = vitr * 0.028;

    for (const w of this.weather) {
      w.phase += 0.06;
      w.rot += 0.04;
      w.x += windDrift + Math.sin(w.phase) * 0.22;
      w.y += w.speedY;
      if (w.y > bottom) {
        w.y = top;
        w.x = left + Math.random() * (right - left);
      }
      if (w.x > right) w.x = left;
      if (w.x < left) w.x = right;
    }
  }

  getShakeOffset() {
    if (this.shakeFrames <= 0 || this.shakeMag <= 0) return [0, 0];
    const amt = this.shakeMag * (this.shakeFrames / 10);
    return [(Math.random() - 0.5) * 2 * amt, (Math.random() - 0.5) * 2 * amt];
  }

  renderWeather(ctx, krajina = 1) {
    if (!this.weather.length) return;
    ctx.save();
    for (const w of this.weather) {
      if (krajina === 1) {
        // Gentle drifting snow
        ctx.fillStyle = `rgba(255, 255, 255, ${w.alpha.toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(w.x, w.y, w.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (krajina === 2) {
        // Soft drifting forest leaves
        ctx.save();
        ctx.translate(w.x, w.y);
        ctx.rotate(w.rot);
        ctx.fillStyle = `rgba(116, 178, 92, ${w.alpha.toFixed(2)})`;
        ctx.beginPath();
        ctx.ellipse(0, 0, w.size * 1.1, w.size * 0.52, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        // Fine warm sand motes
        ctx.fillStyle = `rgba(214, 174, 118, ${(w.alpha * 0.85).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(w.x, w.y, w.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  renderBattleFx(ctx) {
    // 1. Soft smoke trails
    if (this.trails.length) {
      ctx.save();
      for (const tr of this.trails) {
        const a = Math.max(0, 1 - tr.life / tr.maxLife);
        ctx.globalAlpha = a * 0.65;
        ctx.fillStyle = tr.col;
        ctx.beginPath();
        ctx.arc(tr.x, tr.y, tr.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // 2. Clean Paper-Cut shockwave ring explosions
    if (this.explosions.length) {
      ctx.save();
      for (const e of this.explosions) {
        const t = e.frame / e.maxFrames;
        const easeOut = 1 - Math.pow(1 - t, 3);
        const ringR = e.maxR * (0.25 + easeOut * 1.05);
        const coreR = e.maxR * (t < 0.35 ? (0.3 + (t / 0.35) * 0.6) : Math.max(0, 0.9 * (1 - (t - 0.35) / 0.65)));

        // Outer crisp shockwave ring
        ctx.globalAlpha = Math.max(0, (1 - t) * 0.85);
        ctx.strokeStyle = e.ringCol;
        ctx.lineWidth = Math.max(0.9, 2.4 * (1 - t));
        ctx.beginPath();
        ctx.arc(e.x, e.y, ringR, 0, Math.PI * 2);
        ctx.stroke();

        // Warm middle blast disc
        if (coreR > 1) {
          ctx.globalAlpha = Math.max(0, (1 - t) * 0.88);
          ctx.fillStyle = e.midCol;
          ctx.beginPath();
          ctx.arc(e.x, e.y, coreR, 0, Math.PI * 2);
          ctx.fill();

          // Bright inner Paper-Cut core
          ctx.fillStyle = e.coreCol;
          ctx.beginPath();
          ctx.arc(e.x, e.y, coreR * 0.56, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // 3. Crisp sparks
    if (this.sparks.length) {
      ctx.save();
      for (const sp of this.sparks) {
        const a = Math.max(0, 1 - sp.life / sp.maxLife);
        ctx.globalAlpha = a;
        ctx.fillStyle = sp.col;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, sp.r * (0.5 + 0.5 * a), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // 4. Floating combat damage / bounty popups
    if (this.popups.length) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const p of this.popups) {
        const t = p.life / p.maxLife;
        const a = t > 0.65 ? Math.max(0, 1 - (t - 0.65) / 0.35) : 1;
        ctx.globalAlpha = a;
        ctx.font = p.large
          ? '800 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
          : '800 9.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.lineWidth = 2.6;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.strokeText(p.text, p.x, p.y);
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, p.x, p.y);
      }
      ctx.restore();
    }
  }
}
