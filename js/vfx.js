// Clean Paper-Cut Visual Effects Engine (purely cosmetic, never touches deterministic game RNG)
// Handles: shockwave ring explosions, soft smoke trails, floating damage/bounty popups,
// subtle screen shake, and wind-driven ambient weather (snow, drifting leaves, desert motes).

import { STAGE_W, STAGE_H } from './constants.js';

export class VfxManager {
  constructor() {
    this.explosions = []; // { x, y, maxR, frame, maxFrames, coreCol, ringCol }
    this.ribbons = [];    // continuous tapered projectile contrails
    this.trails = [];     // soft wispy smoke puffs
    this.sparks = [];     // { x, y, vx, vy, r, col, life, maxLife }
    this.popups = [];     // { x, y, vy, text, color, life, maxLife, scale }
    this.weather = [];    // ambient particles across viewport
    this.weatherKrajina = 0;
    this.shakeFrames = 0;
    this.shakeMag = 0;
    this._nextRibbonId = 1;
  }

  clearBattleFx() {
    this.explosions = [];
    this.ribbons = [];
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

  // Create a continuous tapered contrail ribbon for a projectile
  createTrailRibbon(opts = {}) {
    const isNuke = Boolean(opts.isNuke);
    const isHeavy = Boolean(opts.isHeavy);
    const ribbon = {
      id: this._nextRibbonId++,
      points: [],
      width: isNuke ? 4.2 : isHeavy ? 3.1 : 2.2,
      maxLife: isNuke ? 38 : isHeavy ? 32 : 26,
      col: opts.col || '#ffffff',
      edgeCol: opts.edgeCol || 'rgba(15, 23, 42, 0.14)',
      emberCol: opts.emberCol || '#fb923c',
      isHeavy: isHeavy || isNuke,
      finished: false,
      stepCount: 0,
    };
    this.ribbons.push(ribbon);
    if (this.ribbons.length > 48) {
      this.ribbons.shift();
    }
    return ribbon;
  }

  pushTrailPoint(ribbon, x, y, emitPuff = true) {
    if (!ribbon || ribbon.finished) return;
    const pts = ribbon.points;
    const last = pts.length ? pts[pts.length - 1] : null;
    if (last) {
      const dx = x - last.x;
      const dy = y - last.y;
      if (dx * dx + dy * dy < 0.25) return;
    }
    pts.push({ x, y, life: 0, maxLife: ribbon.maxLife });
    ribbon.stepCount++;

    // Subtle wispy Paper-Cut puff spaced cleanly along the exhaust wake
    if (emitPuff && ribbon.stepCount >= 3 && ribbon.stepCount % 3 === 0 && last) {
      const mx = (last.x + x) * 0.5;
      const my = (last.y + y) * 0.5;
      this.spawnTrail(mx, my, ribbon.isHeavy, ribbon.col === '#ffffff' ? 'rgba(255,255,255,0.34)' : 'rgba(254,215,170,0.34)');
    }
  }

  finishTrailRibbon(ribbon, finalX = null, finalY = null) {
    if (!ribbon || ribbon.finished) return;
    if (finalX !== null && finalY !== null) {
      const pts = ribbon.points;
      const last = pts.length ? pts[pts.length - 1] : null;
      if (!last || Math.hypot(finalX - last.x, finalY - last.y) > 0.5) {
        pts.push({ x: finalX, y: finalY, life: 0, maxLife: ribbon.maxLife });
      }
    }
    ribbon.finished = true;
  }

  spawnTrail(x, y, isHeavy = false, col = 'rgba(255,255,255,0.45)') {
    this.trails.push({
      x: x + (Math.random() - 0.5) * 0.8,
      y: y + (Math.random() - 0.5) * 0.8,
      vx: (Math.random() - 0.5) * 0.1,
      vy: -0.09 - Math.random() * 0.08,
      r: isHeavy ? 2.4 : 1.5,
      col,
      life: 0,
      maxLife: isHeavy ? 18 : 14,
    });
    if (this.trails.length > 160) {
      this.trails.splice(0, this.trails.length - 160);
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

    // Continuous contrail ribbons (gentle wind drift + smooth tail fade)
    for (let i = this.ribbons.length - 1; i >= 0; i--) {
      const r = this.ribbons[i];
      for (const pt of r.points) {
        pt.life++;
        // Drift older points very softly so exhaust curves naturally in wind
        const ageFrac = pt.life / pt.maxLife;
        pt.x += vitr * 0.0022 * ageFrac;
        pt.y -= 0.035 * ageFrac;
      }
      while (r.points.length && r.points[0].life >= r.points[0].maxLife) {
        r.points.shift();
      }
      if (r.finished && r.points.length < 2) {
        this.ribbons.splice(i, 1);
      }
    }

    // Smoke trails
    for (let i = this.trails.length - 1; i >= 0; i--) {
      const tr = this.trails[i];
      tr.x += tr.vx + vitr * 0.003;
      tr.y += tr.vy;
      tr.r += 0.09;
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

  // Helper: build a single closed bead-free tapered ribbon polygon from polyline points
  _traceTaperedRibbon(ctx, pts, widthScale = 1, startIdx = 0) {
    const n = pts.length;
    const count = n - startIdx;
    if (count < 2) return false;

    const leftX = new Array(count);
    const leftY = new Array(count);
    const rightX = new Array(count);
    const rightY = new Array(count);

    for (let k = 0; k < count; k++) {
      const i = startIdx + k;
      const p = pts[i];
      const pPrev = pts[Math.max(startIdx, i - 1)];
      const pNext = pts[Math.min(n - 1, i + 1)];
      let tx = pNext.x - pPrev.x;
      let ty = pNext.y - pPrev.y;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      // Perpendicular normal
      const nx = -ty;
      const ny = tx;

      const lifeFrac = Math.max(0, 1 - p.life / p.maxLife);
      const posFrac = k / (count - 1);
      // Smooth teardrop taper: 0px at tail -> full width right behind rocket thruster
      const hw = widthScale * Math.pow(posFrac, 0.85) * Math.pow(lifeFrac, 0.65);

      leftX[k] = p.x + nx * hw;
      leftY[k] = p.y + ny * hw;
      rightX[k] = p.x - nx * hw;
      rightY[k] = p.y - ny * hw;
    }

    ctx.beginPath();
    ctx.moveTo(leftX[0], leftY[0]);
    for (let k = 1; k < count; k++) {
      ctx.lineTo(leftX[k], leftY[k]);
    }
    for (let k = count - 1; k >= 0; k--) {
      ctx.lineTo(rightX[k], rightY[k]);
    }
    ctx.closePath();
    return true;
  }

  // Rendered BEHIND projectiles so the rocket nose & body stay crisp above its exhaust
  renderTrails(ctx) {
    // 1. Subtle wispy exhaust puffs
    if (this.trails.length) {
      ctx.save();
      for (const tr of this.trails) {
        const a = Math.max(0, 1 - tr.life / tr.maxLife);
        ctx.globalAlpha = a * 0.38;
        ctx.fillStyle = tr.col;
        ctx.beginPath();
        ctx.arc(tr.x, tr.y, tr.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // 2. Smooth continuous bead-free tapered Paper-Cut contrail ribbons
    if (!this.ribbons.length) return;
    ctx.save();

    for (const r of this.ribbons) {
      const pts = r.points;
      const n = pts.length;
      if (n < 2) continue;

      const newest = pts[n - 1];
      const headLife = Math.max(0, 1 - newest.life / newest.maxLife);
      if (headLife <= 0.02) continue;

      const halfW = r.width * 0.5;

      // Subtle contrast outline so white contrails stay crisp over Snow Mountains too
      if (this._traceTaperedRibbon(ctx, pts, halfW + 0.75, 0)) {
        ctx.globalAlpha = headLife * 0.24;
        ctx.fillStyle = r.edgeCol;
        ctx.fill();
      }

      // Crisp Paper-Cut main contrail body (single filled polygon -> zero overlapping alpha dots!)
      if (this._traceTaperedRibbon(ctx, pts, halfW, 0)) {
        ctx.globalAlpha = headLife * 0.86;
        ctx.fillStyle = r.col;
        ctx.fill();
      }

      // Warm glowing rocket jet directly behind an active flying projectile
      if (!r.finished && n >= 2) {
        const jetStart = Math.max(0, n - 5);
        if (this._traceTaperedRibbon(ctx, pts, halfW * 0.65, jetStart)) {
          ctx.globalAlpha = headLife * 0.82;
          ctx.fillStyle = r.emberCol;
          ctx.fill();
        }
        const coreStart = Math.max(0, n - 3);
        if (this._traceTaperedRibbon(ctx, pts, halfW * 0.38, coreStart)) {
          ctx.globalAlpha = headLife * 0.92;
          ctx.fillStyle = '#fde047';
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // Rendered ABOVE projectiles (shockwaves, sparks, floating popups)
  renderBattleFx(ctx) {
    // 1. Clean Paper-Cut shockwave ring explosions
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
