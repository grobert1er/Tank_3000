// Procedural terrain generator, tree physics, and crater carving

import { STAGE_W, STAGE_H } from './constants.js';

export class Terrain {
  constructor() {
    this.krajina = 1; // 1 = Mountains (snow), 2 = Forest (green), 3 = Desert (sand)
    this.vitr = 0;
    this.vitrchange = 16;
    // 550 individual 1px columns: { x, y (center), height, color }
    // Top surface of column x is: topY(x) = col.y - col.height / 2
    this.cols = new Array(STAGE_W);
    this.trees = []; // { kind: 'strom_1'|'strom_2', x, y, fall }
    // Animated sky clouds & sun
    this.sunFrame = 0;
    this.clouds = [];
    this._genState = null;
  }

  // Begin progressive terrain generation (40 columns per tick)
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
      // Mountains / Snow
      this.vitrchange = 16;
      this.vitr = (rng.random(50) + 30) * rn;
      baseLandY = 497.6;
      n2 = rng.random(200) + 100;
      n3 = rng.random(300) + 50;
      n4 = rng.random(300) + 50;
      ran = rng.random(500);
      pocet = rng.random(5) + 2;
      this.clouds = [];
    } else if (k === 2) {
      // Forest / Grass
      this.vitrchange = 12;
      this.vitr = (rng.random(25) + 25) * rn;
      baseLandY = 536;
      n2 = rng.random(100) + 50;
      n3 = rng.random(200) + 50;
      n4 = rng.random(200) + 50;
      ran = rng.random(500);
      pocet = rng.random(6) + 2;
      rng.random(50); // matches `f = random(50) + 10;` in Frame 4 load
      // 3 clouds from Sprite 79 (krajina2): positions relative to krajina2 center (248.8, 334.6)
      this.clouds = [
        { spriteId: 73, x: 113.5, y: -119.7, drift: 0 },
        { spriteId: 73, x: -143.7, y: -145.3, drift: 0 },
        { spriteId: 73, x: 17.3, y: -251.9, drift: 0 },
      ];
    } else {
      // Desert
      this.vitrchange = 6;
      this.vitr = rng.random(20) * rn;
      baseLandY = 615;
      rand = rng.random(400) / 10 + 1;
      rand2 = (rng.random(15) + 1) / 10;
      // 2 clouds from Sprite 94 (krajina3)
      this.clouds = [
        { spriteId: 82, x: 121.0, y: -68.0, drift: 0.2 },
        { spriteId: 82, x: -134.1, y: -130.8, drift: 0.2 },
      ];
    }

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

  // Advance terrain generation by batchSize columns per tick
  stepGenerate(rng, batchSize = 40) {
    const st = this._genState;
    if (!st || st.done) return 100;

    const end = Math.min(STAGE_W, st.i + batchSize);
    for (let i = st.i; i < end; i++) {
      let y = st.baseLandY;
      const height = 500.0;
      let color;
      if (this.krajina === 1) {
        y = y + (Math.sin((Math.PI / st.n3) * i) * Math.cos((Math.PI / st.n4) * i) * (st.ran - i)) / 2;
        color = '#ffffff';
      } else if (this.krajina === 2) {
        y = y + (((Math.sin((Math.PI / 180) * i) * Math.cos((Math.PI / st.n4) * i)) * (st.ran - i)) / 4) / 2;
        const barv = height / 12;
        const g = Math.min(255, Math.round(130 + barv));
        color = `rgb(120,${g},0)`;
      } else {
        y = y + (Math.sin((Math.PI / 180) * i * st.rand2) * st.rand) / 2;
        color = 'rgb(234,221,181)';
      }
      this.cols[i] = { x: i, y, height, color };
    }
    st.i = end;

    if (st.i >= STAGE_W) {
      // Spawn landscape trees
      if (this.krajina === 1) {
        for (let t = 0; t < st.pocet; t++) {
          const tx = rng.random(STAGE_W);
          this.trees.push({
            kind: 'strom_1',
            x: tx,
            y: this.topY(tx),
            fall: 0,
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
          });
          fx = fx + (rng.random(30) + 8);
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

  // Hit test a point (px, py) with small vertical bounding box against terrain column
  hitPoint(px, py, halfH = 1.15) {
    const col = this.getCol(px);
    if (!col || col.height <= 0) return false;
    const top = col.y - col.height / 2;
    const bot = col.y + col.height / 2;
    return py + halfH >= top && py - halfH <= bot;
  }

  // Carve elliptical blast crater into terrain columns
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

      // Test if top surface point (x, h) lies inside the explosion ellipse
      const dx = (x - xx) / (rx || 1);
      const dy = (h - yy) / (ry || 1);
      if (dx * dx + dy * dy <= 1.0) {
        const dist = Math.sqrt((xx - x) * (xx - x) + (yy - h) * (yy - h));
        const vzr = Math.cos(0.017 * (dist * (180 / blastW)));
        cur.height = Math.max(0, cur.height - par1 * vzr);
        cur.y = cur.y + par2 * vzr;
      } else {
        // Fallback bounding box hitTest against the column
        const overlapX = Math.abs(x - xx) <= rx + 0.5;
        const overlapY = yy + ry >= h && yy - ry <= bot;
        if (overlapX && overlapY) {
          const vzr2 = Math.cos(0.017 * (Math.abs(xx - x) * (180 / blastW)));
          const dh = par3 * vzr2;
          cur.height = Math.max(0, cur.height - dh);
          cur.y = cur.y + dh / 2;
        }
      }
      if (this.krajina === 2) {
        const g = Math.min(255, Math.round(130 + cur.height / 12));
        cur.color = `rgb(120,${g},0)`;
      }
    }
  }

  // Exact tank death crater carving from Sprite 31 Frame 9
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
      } else if (Math.abs(x - tx) <= rx + 0.5 && ty + ry >= h && ty - ry <= bot) {
        const d = Math.max(1, Math.abs(tx - x));
        const dh = 50 / d;
        cur.height = Math.max(0, cur.height - dh);
        cur.y = cur.y + dh / 2;
      }
      if (this.krajina === 2) {
        const g = Math.min(255, Math.round(130 + cur.height / 12));
        cur.color = `rgb(120,${g},0)`;
      }
    }
  }

  // Flatten columns immediately beneath a newly spawned tank (Sprite 31 Frame 1 lines 183-191)
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

  // Update wind between turns
  updateWind(rng) {
    this.vitr = this.vitr + (0 - rng.random(this.vitrchange) + this.vitrchange / 2);
  }

  // Tick animated sky (sun + wind-drifting clouds) and falling trees at 25Hz
  tick() {
    this.sunFrame = (this.sunFrame + 1) % 40;
    for (const c of this.clouds) {
      c.x += this.vitr / 80 + c.drift;
      if (c.drift > 0) {
        if (c.x > 460) c.x = -60;
        if (c.x < -360) c.x = 360;
      } else {
        if (c.x > 360) c.x = -360;
        if (c.x < -360) c.x = 360;
      }
    }
    // Trees fall when ground beneath them is cratered (strom_1 & strom_2 Frame 2)
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

  renderBackground(ctx, renderer) {
    ctx.save();
    if (this.krajina === 1) {
      ctx.translate(274, 203.4);
      renderer.drawSprite(ctx, 'krajina1', {
        overrides: {
          slunce: { frame: this.sunFrame },
        },
      });
    } else if (this.krajina === 2) {
      ctx.translate(248.8, 334.6);
      renderer.drawSprite(ctx, 'krajina2', {
        skipCids: new Set([73]),
        overrides: {
          slunce: { frame: this.sunFrame },
        },
      });
      for (const c of this.clouds) {
        ctx.save();
        ctx.translate(c.x, c.y);
        renderer.drawSprite(ctx, c.spriteId);
        ctx.restore();
      }
    } else {
      ctx.translate(274, 200.6);
      renderer.drawSprite(ctx, 'krajina3', {
        skipCids: new Set([82]),
        overrides: {
          slunce: { frame: this.sunFrame },
        },
      });
      for (const c of this.clouds) {
        ctx.save();
        ctx.translate(c.x, c.y);
        renderer.drawSprite(ctx, c.spriteId);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  renderColumns(ctx) {
    // Seamless terrain rendering with zero HiDPI subpixel vertical seams
    if (this.krajina === 1 || this.krajina === 3) {
      // Uniform color terrain (Mountains snow #ffffff / Desert sand rgb(234,221,181))
      ctx.save();
      ctx.fillStyle = this.krajina === 1 ? '#ffffff' : 'rgb(234,221,181)';
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < STAGE_W; i++) {
        const c = this.cols[i];
        const top = c && c.height > 0 ? Math.min(STAGE_H + 2, c.y - c.height / 2) : STAGE_H + 2;
        if (!started) {
          ctx.moveTo(i - 0.5, STAGE_H + 2);
          ctx.lineTo(i - 0.5, top);
          started = true;
        } else {
          ctx.lineTo(i, top);
        }
      }
      ctx.lineTo(STAGE_W + 0.5, STAGE_H + 2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      return;
    }

    // Forest (krajina 2): group contiguous same-color columns into seamless filled spans
    // (preserving exact per-column crater color darkening without vertical or diagonal seams)
    ctx.save();
    let runStart = -1;
    let runColor = null;
    const flushRun = (endIdx) => {
      if (runStart < 0) return;
      ctx.fillStyle = runColor;
      ctx.beginPath();
      const firstCol = this.cols[runStart];
      const firstTop = firstCol && firstCol.height > 0 ? Math.min(STAGE_H + 2, firstCol.y - firstCol.height / 2) : STAGE_H + 2;
      ctx.moveTo(runStart - 0.5, STAGE_H + 2);
      ctx.lineTo(runStart - 0.5, firstTop);
      let lastTop = firstTop;
      for (let k = runStart; k < endIdx; k++) {
        const col = this.cols[k];
        const top = col && col.height > 0 ? Math.min(STAGE_H + 2, col.y - col.height / 2) : STAGE_H + 2;
        ctx.lineTo(k, top);
        lastTop = top;
      }
      ctx.lineTo(endIdx - 0.4, lastTop);
      ctx.lineTo(endIdx - 0.4, STAGE_H + 2);
      ctx.closePath();
      ctx.fill();
      runStart = -1;
      runColor = null;
    };

    for (let i = 0; i < STAGE_W; i++) {
      const c = this.cols[i];
      if (!c || c.height <= 0) {
        flushRun(i);
        continue;
      }
      if (c.color !== runColor) {
        flushRun(i);
        runStart = i;
        runColor = c.color;
      }
    }
    flushRun(STAGE_W);
    ctx.restore();
  }

  renderTrees(ctx, renderer) {
    for (const tr of this.trees) {
      if (tr.y > STAGE_H + 30) continue;
      ctx.save();
      ctx.translate(tr.x, tr.y);
      renderer.drawSprite(ctx, tr.kind);
      ctx.restore();
    }
  }

  // Snapshot / restore for online sync
  serialize() {
    return {
      krajina: this.krajina,
      vitr: this.vitr,
      vitrchange: this.vitrchange,
      cols: this.cols.map((c) => (c ? [Math.round(c.y * 10) / 10, Math.round(c.height * 10) / 10] : null)),
      trees: this.trees.map((t) => [t.kind, t.x, Math.round(t.y * 10) / 10]),
    };
  }

  deserialize(snap) {
    this.krajina = snap.krajina;
    this.vitr = snap.vitr;
    this.vitrchange = snap.vitrchange;
    this.cols = snap.cols.map((arr, i) => {
      if (!arr) return null;
      const [y, height] = arr;
      let color = '#ffffff';
      if (this.krajina === 2) {
        const g = Math.min(255, Math.round(130 + height / 12));
        color = `rgb(120,${g},0)`;
      } else if (this.krajina === 3) {
        color = 'rgb(234,221,181)';
      }
      return { x: i, y, height, color };
    });
    this.trees = snap.trees.map(([kind, x, y]) => ({ kind, x, y, fall: 0 }));
  }
}
