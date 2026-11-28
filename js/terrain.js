// Procedural terrain generator, Clean Paper-Cut full-viewport landscapes, tree physics, and crater carving

import { STAGE_W, STAGE_H } from './constants.js';

export const BIOME_PALETTES = {
  // 1: Snow Mountains (Alto-inspired crisp alpine palette)
  1: {
    name: 'Mountains',
    skyTop: '#4e8bc4',
    skyMid: '#b4dafb',
    skyBot: '#edf6fc',
    sun: '#fff7d6',
    sunGlow: 'rgba(255, 247, 214, 0.35)',
    mtnFar: '#86b5de',
    mtnMid: '#6899c7',
    mtnNear: '#5889b8',
    ground: '#f4f8fc',
    groundSub: '#dce8f3',
    groundRim: '#ffffff',
    scorch: '#cbd8e6',
    treeDark: '#476f91',
    treeLight: '#5a84a8',
    cloud: 'rgba(255, 255, 255, 0.56)',
  },
  // 2: Forest Hills (silky atmospheric turquoise-to-meadow)
  2: {
    name: 'Forest',
    skyTop: '#4796c9',
    skyMid: '#a7d9f4',
    skyBot: '#e5f3e9',
    sun: '#fff5c2',
    sunGlow: 'rgba(255, 245, 194, 0.35)',
    mtnFar: '#72a89d',
    mtnMid: '#568d82',
    mtnNear: '#477b70',
    ground: '#61a35a',
    groundSub: '#4a8546',
    groundRim: '#88c979',
    scorch: '#5c6b47',
    treeDark: '#2f6139',
    treeLight: '#417a4b',
    cloud: 'rgba(255, 255, 255, 0.54)',
  },
  // 3: Desert Dunes (warm sunlit horizon)
  3: {
    name: 'Desert',
    skyTop: '#5c93c7',
    skyMid: '#e8c89c',
    skyBot: '#fbe8c8',
    sun: '#fff0b3',
    sunGlow: 'rgba(255, 238, 170, 0.4)',
    mtnFar: '#cfa57a',
    mtnMid: '#b5885c',
    mtnNear: '#a0744a',
    ground: '#e7c896',
    groundSub: '#d1ac74',
    groundRim: '#f6e2bd',
    scorch: '#b38d62',
    treeDark: '#738240',
    treeLight: '#88994d',
    cloud: 'rgba(255, 250, 240, 0.48)',
  },
};

export class Terrain {
  constructor() {
    this.krajina = 1; // 1 = Mountains, 2 = Forest, 3 = Desert
    this.vitr = 0;
    this.vitrchange = 16;
    // 550 individual 1px columns: { x, y (center), height, color, scorch }
    this.cols = new Array(STAGE_W);
    this.trees = []; // { kind: 'strom_1'|'strom_2', x, y, fall, scale }
    this.sunFrame = 0;
    this.clouds = [];
    this._genState = null;
  }

  _initClouds() {
    this.clouds = [
      { x: 95,  y: 78,  rx: 38, ry: 11, drift: 0.08, alpha: 0.58 },
      { x: 290, y: 58,  rx: 46, ry: 13, drift: 0.05, alpha: 0.48 },
      { x: 470, y: 86,  rx: 34, ry: 10, drift: 0.11, alpha: 0.52 },
      { x: -110, y: 92, rx: 42, ry: 12, drift: 0.07, alpha: 0.45 },
      { x: 660, y: 68,  rx: 44, ry: 12, drift: 0.06, alpha: 0.50 },
    ];
  }

  // Begin progressive terrain generation (deterministic RNG consumption preserved)
  beginGenerate(krajinaSetting, rng, instant = false) {
    let k = krajinaSetting;
    if (k === 0) {
      k = rng.random(3) + 1;
    }
    this.krajina = k;
    this.trees = [];
    this.sunFrame = 0;

    let rn = 0;
    while (rn === 0) rn = rng.random(3) - 1;

    let baseLandY = 497.6;
    let n2 = 0, n3 = 0, n4 = 0, ran = 0, pocet = 0, rand = 0, rand2 = 0;

    if (k === 1) {
      this.vitrchange = 16;
      this.vitr = (rng.random(50) + 30) * rn;
      baseLandY = 497.6;
      n2 = rng.random(200) + 100;
      n3 = rng.random(300) + 50;
      n4 = rng.random(300) + 50;
      ran = rng.random(500);
      pocet = rng.random(5) + 3;
    } else if (k === 2) {
      this.vitrchange = 12;
      this.vitr = (rng.random(25) + 25) * rn;
      baseLandY = 536;
      n2 = rng.random(100) + 50;
      n3 = rng.random(200) + 50;
      n4 = rng.random(200) + 50;
      ran = rng.random(500);
      pocet = rng.random(6) + 2;
      rng.random(50);
    } else {
      this.vitrchange = 6;
      this.vitr = rng.random(20) * rn;
      baseLandY = 615;
      rand = rng.random(400) / 10 + 1;
      rand2 = (rng.random(15) + 1) / 10;
    }

    this._initClouds();

    this._genState = {
      i: 0,
      done: false,
      baseLandY,
      n2, n3, n4, ran, pocet, rand, rand2,
    };

    if (instant) {
      while (!this._genState.done) {
        this.stepGenerate(rng, 550);
      }
    }
  }

  stepGenerate(rng, batchSize = 40) {
    const st = this._genState;
    if (!st || st.done) return 100;

    const pal = BIOME_PALETTES[this.krajina] || BIOME_PALETTES[1];
    const end = Math.min(STAGE_W, st.i + batchSize);
    for (let i = st.i; i < end; i++) {
      let y = st.baseLandY;
      const height = 500.0;
      if (this.krajina === 1) {
        y = y + (Math.sin((Math.PI / st.n3) * i) * Math.cos((Math.PI / st.n4) * i) * (st.ran - i)) / 2;
      } else if (this.krajina === 2) {
        y = y + (((Math.sin((Math.PI / 180) * i) * Math.cos((Math.PI / st.n4) * i)) * (st.ran - i)) / 4) / 2;
      } else {
        y = y + (Math.sin((Math.PI / 180) * i * st.rand2) * st.rand) / 2;
      }
      this.cols[i] = { x: i, y, height, color: pal.ground, scorch: 0 };
    }
    st.i = end;

    if (st.i >= STAGE_W) {
      if (this.krajina === 1) {
        for (let t = 0; t < st.pocet; t++) {
          const tx = rng.random(STAGE_W);
          this.trees.push({
            kind: 'strom_1',
            x: tx,
            y: this.topY(tx),
            fall: 0,
            scale: 0.78 + (tx % 5) * 0.08,
          });
        }
      } else if (this.krajina === 2) {
        let fx = 0;
        for (let t = 0; t < 100; t++) {
          const colX = Math.max(0, Math.min(STAGE_W - 1, Math.round(fx)));
          this.trees.push({
            kind: 'strom_2',
            x: colX,
            y: this.topY(colX),
            fall: 0,
            scale: 0.72 + (colX % 5) * 0.08,
          });
          fx = fx + (rng.random(30) + 12);
          if (fx > STAGE_W) break;
        }
      }
      st.done = true;
      return 100;
    }
    return Math.round((st.i / STAGE_W) * 100);
  }

  getCol(x) {
    const ix = Math.round(x);
    if (ix < 0 || ix >= STAGE_W) return null;
    return this.cols[ix];
  }

  topY(x) {
    const col = this.getCol(x);
    if (!col) return STAGE_H + 100;
    return col.y - col.height / 2;
  }

  hitPoint(px, py, halfH = 1.15) {
    const col = this.getCol(px);
    if (!col || col.height <= 0) return false;
    const top = col.y - col.height / 2;
    const bot = col.y + col.height / 2;
    return py + halfH >= top && py - halfH <= bot;
  }

  carveExplosion(xx, yy, blastW, blastH, par1, par2, par3) {
    const rx = blastW / 2;
    const ry = blastH / 2;
    for (let i = 0; i < blastW; i++) {
      const ix = Math.round(xx - blastW / 2 + i);
      if (ix < 0 || ix >= STAGE_W) continue;
      const cur = this.cols[ix];
      if (!cur || cur.height <= 0) continue;
      const x = cur.x;
      const h = cur.y - cur.height / 2;
      const bot = cur.y + cur.height / 2;

      const dx = (x - xx) / (rx || 1);
      const dy = (h - yy) / (ry || 1);
      if (dx * dx + dy * dy <= 1.0) {
        const dist = Math.sqrt((xx - x) * (xx - x) + (yy - h) * (yy - h));
        const vzr = Math.cos(0.017 * (dist * (180 / blastW)));
        cur.height = Math.max(0, cur.height - par1 * vzr);
        cur.y = cur.y + par2 * vzr;
        cur.scorch = Math.min(1, (cur.scorch || 0) + 0.45);
      } else {
        const overlapX = Math.abs(x - xx) <= rx + 0.5;
        const overlapY = yy + ry >= h && yy - ry <= bot;
        if (overlapX && overlapY) {
          const vzr2 = Math.cos(0.017 * (Math.abs(xx - x) * (180 / blastW)));
          const dh = par3 * vzr2;
          cur.height = Math.max(0, cur.height - dh);
          cur.y = cur.y + dh / 2;
          cur.scorch = Math.min(1, (cur.scorch || 0) + 0.3);
        }
      }
    }
  }

  carveTankDeath(tx, ty, blastW = 70, blastH = 40) {
    const rx = blastW / 2;
    const ry = blastH / 2;
    for (let i = 0; i < blastW; i++) {
      const ix = Math.round(tx - blastW / 2 + i);
      if (ix < 0 || ix >= STAGE_W) continue;
      const cur = this.cols[ix];
      if (!cur || cur.height <= 0) continue;
      const x = cur.x;
      const h = cur.y - cur.height / 2;
      const bot = cur.y + cur.height / 2;
      const dx = (x - tx) / rx;
      const dy = (h - ty) / ry;
      if (dx * dx + dy * dy <= 1.0) {
        const dist = Math.sqrt((tx - x) * (tx - x) + (ty - h) * (ty - h));
        const vzr = Math.cos(0.017 * (dist * (180 / blastW)));
        cur.height = Math.max(0, cur.height - 30 * vzr);
        cur.y = cur.y + 15 * vzr;
        cur.scorch = Math.min(1, (cur.scorch || 0) + 0.65);
      } else if (Math.abs(x - tx) <= rx + 0.5 && ty + ry >= h && ty - ry <= bot) {
        const d = Math.max(1, Math.abs(tx - x));
        const dh = 50 / d;
        cur.height = Math.max(0, cur.height - dh);
        cur.y = cur.y + dh / 2;
        cur.scorch = Math.min(1, (cur.scorch || 0) + 0.45);
      }
    }
  }

  flattenUnderTank(tx, ty, tankW = 16, tankH = 6.5) {
    for (let i = 0; i < tankW; i++) {
      const ix = Math.floor(tx - tankW / 2 + i);
      if (ix < 0 || ix >= STAGE_W) continue;
      const cur = this.cols[ix];
      if (!cur) continue;
      const top = cur.y - cur.height / 2;
      const tankBottom = ty + tankH / 2;
      if (tankBottom >= top) {
        cur.y = cur.y + (tankBottom - top);
      }
    }
  }

  updateWind(rng) {
    this.vitr = this.vitr + (0 - rng.random(this.vitrchange) + this.vitrchange / 2);
  }

  tick(viewBounds = null) {
    this.sunFrame = (this.sunFrame + 1) % 360;
    const minX = (viewBounds ? viewBounds.left : -220) - 80;
    const maxX = (viewBounds ? viewBounds.right : STAGE_W + 220) + 80;
    for (const c of this.clouds) {
      c.x += this.vitr / 140 + (c.drift || 0.06);
      if (c.x > maxX) c.x = minX;
      if (c.x < minX) c.x = maxX;
    }
    for (const tr of this.trees) {
      const groundY = this.topY(tr.x);
      if (Math.floor(tr.y) < Math.floor(groundY)) {
        tr.y += tr.fall;
        tr.fall += 1;
      } else {
        tr.fall = 0;
        if (tr.y > groundY && groundY < STAGE_H + 50) {
          tr.y = groundY;
        }
      }
    }
  }

  // Edge-to-edge Clean Paper-Cut sky, sun, soft clouds, and layered geometric mountains
  renderBackground(ctx, viewBounds = null) {
    const pal = BIOME_PALETTES[this.krajina] || BIOME_PALETTES[1];
    const left = viewBounds ? viewBounds.left - 4 : 0;
    const right = viewBounds ? viewBounds.right + 4 : STAGE_W;
    const top = viewBounds ? viewBounds.top - 4 : 0;
    const bottom = viewBounds ? viewBounds.bottom + 4 : STAGE_H;
    const w = right - left;
    const h = bottom - top;

    ctx.save();

    // 1. Silky 3-stop atmospheric sky gradient
    const sky = ctx.createLinearGradient(0, top, 0, bottom);
    sky.addColorStop(0, pal.skyTop);
    sky.addColorStop(0.62, pal.skyMid);
    sky.addColorStop(1, pal.skyBot);
    ctx.fillStyle = sky;
    ctx.fillRect(left, top, w, h);

    // 2. Soft radiant Paper-Cut sun
    const sunX = 435;
    const sunY = 82;
    const sunPulse = 1 + Math.sin((this.sunFrame * Math.PI) / 180) * 0.04;
    const glow = ctx.createRadialGradient(sunX, sunY, 10, sunX, sunY, 54 * sunPulse);
    glow.addColorStop(0, pal.sunGlow);
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(sunX, sunY, 54 * sunPulse, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = pal.sun;
    ctx.beginPath();
    ctx.arc(sunX, sunY, 22, 0, Math.PI * 2);
    ctx.fill();

    // 3. Soft translucent Paper-Cut clouds (single smooth flat-bottom Alto path — zero overlap seams)
    for (const c of this.clouds) {
      const rx = c.rx;
      const ry = c.ry;
      ctx.fillStyle = pal.cloud;
      ctx.beginPath();
      ctx.moveTo(c.x - rx * 0.85, c.y + ry * 0.45);
      ctx.bezierCurveTo(
        c.x - rx * 1.05, c.y + ry * 0.45,
        c.x - rx * 1.0, c.y - ry * 0.55,
        c.x - rx * 0.48, c.y - ry * 0.48
      );
      ctx.bezierCurveTo(
        c.x - rx * 0.35, c.y - ry * 1.25,
        c.x + rx * 0.32, c.y - ry * 1.3,
        c.x + rx * 0.46, c.y - ry * 0.55
      );
      ctx.bezierCurveTo(
        c.x + rx * 0.98, c.y - ry * 0.62,
        c.x + rx * 1.06, c.y + ry * 0.45,
        c.x + rx * 0.82, c.y + ry * 0.45
      );
      ctx.closePath();
      ctx.fill();
    }

    // 4. Layered geometric Paper-Cut mountain silhouettes extending edge-to-edge
    const drawMountainRange = (peaks, color, alpha, baseOffset) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(left, bottom);
      for (const [px, py] of peaks) {
        ctx.lineTo(px, py + baseOffset);
      }
      ctx.lineTo(right, bottom);
      ctx.closePath();
      ctx.fill();

      // Subtle sunlit right-slope paper-cut highlight facets
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      for (let i = 1; i < peaks.length - 1; i += 2) {
        const [px, py] = peaks[i];
        const [nx, ny] = peaks[i + 1];
        ctx.beginPath();
        ctx.moveTo(px, py + baseOffset);
        ctx.lineTo(nx, ny + baseOffset);
        ctx.lineTo(px + (nx - px) * 0.28, bottom);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    };

    if (this.krajina === 1) {
      drawMountainRange(
        [[-340, 290], [-160, 142], [-20, 252], [115, 134], [250, 254], [385, 118], [525, 246], [690, 140], [890, 268]],
        pal.mtnFar, 0.66, 0
      );
      drawMountainRange(
        [[-320, 315], [-90, 200], [55, 268], [200, 184], [335, 272], [475, 192], [625, 268], [860, 210]],
        pal.mtnMid, 0.54, 0
      );
    } else if (this.krajina === 2) {
      drawMountainRange(
        [[-340, 300], [-140, 185], [10, 258], [160, 175], [315, 255], [465, 168], [620, 248], [860, 196]],
        pal.mtnFar, 0.58, 0
      );
      drawMountainRange(
        [[-320, 320], [-75, 232], [95, 275], [245, 218], [405, 275], [560, 224], [730, 278], [880, 238]],
        pal.mtnMid, 0.48, 0
      );
    } else {
      // Layered flat-topped desert mesas & rolling dunes
      drawMountainRange(
        [[-340, 310], [-140, 215], [20, 265], [140, 205], [240, 205], [310, 262], [450, 198], [530, 198], [620, 262], [860, 220]],
        pal.mtnFar, 0.56, 0
      );
      drawMountainRange(
        [[-320, 325], [-60, 252], [115, 282], [285, 242], [440, 280], [600, 246], [880, 268]],
        pal.mtnMid, 0.45, 0
      );
    }

    ctx.restore();
  }

  // Render destructible 550-column foreground terrain + seamless side extensions for full-viewport fullscreen
  renderColumns(ctx, viewBounds = null, showArenaBounds = true) {
    const pal = BIOME_PALETTES[this.krajina] || BIOME_PALETTES[1];
    const left = viewBounds ? viewBounds.left - 4 : 0;
    const right = viewBounds ? viewBounds.right + 4 : STAGE_W;
    const bottom = viewBounds ? viewBounds.bottom + 4 : STAGE_H + 4;

    // Helper for top Y at any column 0..STAGE_W-1
    const colTop = (i) => {
      const c = this.cols[i];
      return c && c.height > 0 ? Math.min(STAGE_H + 6, c.y - c.height / 2) : STAGE_H + 6;
    };

    const leftEdgeY = colTop(0);
    const rightEdgeY = colTop(STAGE_W - 1);

    ctx.save();

    // 1. Seamless out-of-bounds visual terrain skirts (left of x=0, right of x=550) so fullscreen has zero black bars!
    const drawSkirt = (x0, x1, yStart, yEnd) => {
      const midX = (x0 + x1) * 0.5;
      const midY = (yStart + yEnd) * 0.5 - 6;
      ctx.save();
      // Main body matching active terrain tone
      ctx.beginPath();
      ctx.moveTo(x0, bottom);
      ctx.lineTo(x0, yStart);
      ctx.quadraticCurveTo(midX, midY, x1, yEnd);
      ctx.lineTo(x1, bottom);
      ctx.closePath();
      ctx.fillStyle = pal.ground;
      ctx.fill();

      // Matching subsurface layer clipped inside skirt
      ctx.save();
      ctx.clip();
      ctx.beginPath();
      ctx.moveTo(x0, bottom);
      ctx.lineTo(x0, yStart + 20);
      ctx.quadraticCurveTo(midX, midY + 20, x1, yEnd + 20);
      ctx.lineTo(x1, bottom);
      ctx.closePath();
      ctx.fillStyle = pal.groundSub;
      ctx.globalAlpha = 0.72;
      ctx.fill();
      ctx.restore();

      // Matching surface rim highlight
      ctx.beginPath();
      ctx.moveTo(x0, yStart + 0.6);
      ctx.quadraticCurveTo(midX, midY + 0.6, x1, yEnd + 0.6);
      ctx.strokeStyle = pal.groundRim;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      // Gentle atmospheric wash only during battle to distinguish out-of-bounds wings
      if (showArenaBounds) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.04)';
        ctx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), bottom);
      }
      ctx.restore();
    };

    if (left < 0) {
      drawSkirt(left, 0.5, Math.min(STAGE_H - 18, leftEdgeY + 22), leftEdgeY);
    }
    if (right > STAGE_W) {
      drawSkirt(STAGE_W - 0.5, right, rightEdgeY, Math.min(STAGE_H - 18, rightEdgeY + 22));
    }

    // 2. Main active 550px terrain body (clean flat Paper-Cut polygon)
    ctx.beginPath();
    ctx.moveTo(-0.5, bottom);
    ctx.lineTo(-0.5, colTop(0));
    for (let i = 1; i < STAGE_W; i++) {
      ctx.lineTo(i, colTop(i));
    }
    ctx.lineTo(STAGE_W + 0.5, colTop(STAGE_W - 1));
    ctx.lineTo(STAGE_W + 0.5, bottom);
    ctx.closePath();
    ctx.fillStyle = pal.ground;
    ctx.fill();

    // 3. Soft Paper-Cut subsurface depth layer clipped inside terrain
    ctx.save();
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(-0.5, bottom);
    for (let i = 0; i < STAGE_W; i += 6) {
      const ty = colTop(i);
      const wave = Math.sin(i * 0.025) * 4;
      if (i === 0) ctx.lineTo(-0.5, ty + 20 + wave);
      else ctx.lineTo(i, ty + 20 + wave);
    }
    ctx.lineTo(STAGE_W + 0.5, colTop(STAGE_W - 1) + 20);
    ctx.lineTo(STAGE_W + 0.5, bottom);
    ctx.closePath();
    ctx.fillStyle = pal.groundSub;
    ctx.globalAlpha = 0.72;
    ctx.fill();

    // Subtle scorch tint on cratered columns
    for (let i = 0; i < STAGE_W; i++) {
      const c = this.cols[i];
      if (!c || c.height <= 0 || !c.scorch) continue;
      const ty = colTop(i);
      ctx.fillStyle = pal.scorch;
      ctx.globalAlpha = Math.min(0.7, c.scorch * 0.65);
      ctx.fillRect(i - 0.5, ty, 1.5, 9);
    }
    ctx.restore();

    // 4. Crisp 1.8px Paper-Cut top surface highlight rim along untouched/exposed terrain
    ctx.beginPath();
    let penDown = false;
    for (let i = 0; i < STAGE_W; i++) {
      const c = this.cols[i];
      const ty = colTop(i);
      if (!c || c.height <= 0 || ty >= STAGE_H + 2) {
        penDown = false;
        continue;
      }
      if (!penDown) {
        ctx.moveTo(i, ty + 0.6);
        penDown = true;
      } else {
        ctx.lineTo(i, ty + 0.6);
      }
    }
    ctx.strokeStyle = pal.groundRim;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 5. Delicate arena boundary markers at x=0 and x=550 during battle when viewport extends beyond playfield
    if (showArenaBounds && (left < -4 || right > STAGE_W + 4)) {
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.14)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(0, Math.min(leftEdgeY, 70));
      ctx.lineTo(0, STAGE_H);
      ctx.moveTo(STAGE_W, Math.min(rightEdgeY, 70));
      ctx.lineTo(STAGE_W, STAGE_H);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  // Faceted two-tone Paper-Cut trees
  renderTrees(ctx) {
    const pal = BIOME_PALETTES[this.krajina] || BIOME_PALETTES[1];
    ctx.save();
    for (const tr of this.trees) {
      if (tr.y > STAGE_H + 30) continue;
      const sc = tr.scale || 1;
      ctx.save();
      ctx.translate(tr.x, tr.y);
      ctx.scale(sc, sc);
      // Left shaded half & right sunlit half (iconic Paper-Cut pine)
      ctx.fillStyle = pal.treeDark;
      ctx.beginPath();
      ctx.moveTo(0, -18);
      ctx.lineTo(-5.8, 0);
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = pal.treeLight;
      ctx.beginPath();
      ctx.moveTo(0, -18);
      ctx.lineTo(5.8, 0);
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.fill();

      // Tiny snow cap on Mountain pines
      if (this.krajina === 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.beginPath();
        ctx.moveTo(0, -18);
        ctx.lineTo(-2.1, -11.5);
        ctx.lineTo(2.1, -11.5);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  // Snapshot / restore for online sync & mid-game saves
  serialize() {
    return {
      krajina: this.krajina,
      vitr: this.vitr,
      vitrchange: this.vitrchange,
      cols: this.cols.map((c) =>
        c ? [Math.round(c.y * 10) / 10, Math.round(c.height * 10) / 10, Math.round((c.scorch || 0) * 100) / 100] : null
      ),
      trees: this.trees.map((t) => [t.kind, t.x, Math.round(t.y * 10) / 10, t.scale || 1]),
    };
  }

  deserialize(snap) {
    const pal = BIOME_PALETTES[snap.krajina] || BIOME_PALETTES[1];
    this.krajina = snap.krajina;
    this.vitr = snap.vitr;
    this.vitrchange = snap.vitrchange;
    this.cols = snap.cols.map((arr, i) => {
      if (!arr) return null;
      const [y, height, scorch = 0] = arr;
      return { x: i, y, height, color: pal.ground, scorch };
    });
    this.trees = (snap.trees || []).map(([kind, x, y, scale = 1]) => ({ kind, x, y, fall: 0, scale }));
    if (!this.clouds.length) {
      this._initClouds();
    }
  }
}
