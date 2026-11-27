// HiDPI Canvas2D Vector, Morph, Bitmap, Font, Text, Button & Sprite Renderer

const IDENTITY_CX = { mr: 1, mg: 1, mb: 1, ma: 1, ar: 0, ag: 0, ab: 0, aa: 0 };

export function parseCx(cx) {
  if (!cx) return IDENTITY_CX;
  const m = cx.mult || [256, 256, 256, 256];
  const a = cx.add || [0, 0, 0, 0];
  return {
    mr: (m[0] ?? 256) / 256,
    mg: (m[1] ?? 256) / 256,
    mb: (m[2] ?? 256) / 256,
    ma: (m[3] ?? 256) / 256,
    ar: a[0] ?? 0,
    ag: a[1] ?? 0,
    ab: a[2] ?? 0,
    aa: a[3] ?? 0,
  };
}

export function rgbToCx(hexColor, alpha = 1) {
  const r = (hexColor >> 16) & 0xFF;
  const g = (hexColor >> 8) & 0xFF;
  const b = hexColor & 0xFF;
  return { mr: 0, mg: 0, mb: 0, ma: alpha, ar: r, ag: g, ab: b, aa: 0 };
}

export function alphaCx(alpha) {
  return { mr: 1, mg: 1, mb: 1, ma: alpha, ar: 0, ag: 0, ab: 0, aa: 0 };
}

export function concatCx(parent, child) {
  if (!child || child === IDENTITY_CX) return parent;
  if (!parent || parent === IDENTITY_CX) return child;
  return {
    mr: parent.mr * child.mr,
    mg: parent.mg * child.mg,
    mb: parent.mb * child.mb,
    ma: parent.ma * child.ma,
    ar: parent.mr * child.ar + parent.ar,
    ag: parent.mg * child.ag + parent.ag,
    ab: parent.mb * child.ab + parent.ab,
    aa: parent.ma * child.aa + parent.aa,
  };
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function applyCxToColor(rgba, cx) {
  let r = rgba[0], g = rgba[1], b = rgba[2], a = rgba[3];
  if (cx && cx !== IDENTITY_CX) {
    r = clamp255(r * cx.mr + cx.ar);
    g = clamp255(g * cx.mg + cx.ag);
    b = clamp255(b * cx.mb + cx.ab);
    a = clamp255(a * cx.ma + cx.aa);
  }
  return `rgba(${r},${g},${b},${(a / 255).toFixed(4)})`;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpColor(c1, c2, t) {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
    Math.round(lerp(c1[3], c2[3], t)),
  ];
}

function lerpMatrix(m1, m2, t) {
  if (!m2) return m1;
  return {
    sx: lerp(m1.sx, m2.sx, t),
    sy: lerp(m1.sy, m2.sy, t),
    r0: lerp(m1.r0, m2.r0, t),
    r1: lerp(m1.r1, m2.r1, t),
    tx: lerp(m1.tx, m2.tx, t),
    ty: lerp(m1.ty, m2.ty, t),
  };
}

function stitchMorphEdges(edges) {
  const byStart = new Map();
  for (let i = 0; i < edges.length; i++) {
    const k = `${Math.round(edges[i][1])},${Math.round(edges[i][2])}`;
    let arr = byStart.get(k);
    if (!arr) { arr = []; byStart.set(k, arr); }
    arr.push(i);
  }
  const used = new Uint8Array(edges.length);
  const subpaths = [];
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const ed = edges[i];
    const sp = [[ed[1] / 20, ed[2] / 20]];
    const addSeg = (seg) => {
      if (seg[0] === 'L') {
        sp.push(['L', seg[3] / 20, seg[4] / 20]);
        return [seg[3], seg[4]];
      }
      sp.push(['Q', seg[3] / 20, seg[4] / 20, seg[5] / 20, seg[6] / 20]);
      return [seg[5], seg[6]];
    };
    let [cx, cy] = addSeg(ed);
    while (true) {
      const k = `${Math.round(cx)},${Math.round(cy)}`;
      const cands = byStart.get(k);
      let nxt = -1;
      if (cands) {
        for (let j = 0; j < cands.length; j++) {
          if (!used[cands[j]]) { nxt = cands[j]; break; }
        }
      }
      if (nxt === -1) break;
      used[nxt] = 1;
      [cx, cy] = addSeg(edges[nxt]);
    }
    subpaths.push(sp);
  }
  return subpaths;
}

export class VectorRenderer {
  constructor() {
    this.data = null;
    this.images = new Map();
    this._morphCache = new Map();
    this._boundsCache = new Map();
    this._fontCodeMaps = new Map();
  }

  async load(url = 'assets/game-assets.json') {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load ${url}: ${resp.status}`);
    this.data = await resp.json();

    // Build charCode -> glyph index maps for embedded outline fonts
    for (const [fid, font] of Object.entries(this.data.fonts || {})) {
      if (font.codes && font.codes.length) {
        const cmap = new Map();
        for (let i = 0; i < font.codes.length; i++) {
          cmap.set(font.codes[i], i);
        }
        this._fontCodeMaps.set(String(fid), cmap);
      }
    }

    // Load all bitmaps
    const entries = Object.entries(this.data.bitmaps || {});
    await Promise.all(
      entries.map(
        ([idStr, info]) =>
          new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              this.images.set(Number(idStr), img);
              resolve();
            };
            img.onerror = () => {
              console.warn('Failed to load bitmap', idStr, info.file);
              resolve();
            };
            img.src = info.file;
          })
      )
    );
    return this.data;
  }

  getExportId(name) {
    return this.data?.exports?.[name] ?? null;
  }

  getSprite(cidOrName) {
    const cid = typeof cidOrName === 'string' ? this.getExportId(cidOrName) : cidOrName;
    if (cid == null) return null;
    return this.data.sprites[String(cid)] || null;
  }

  getBounds(cid, frameIdx = 0) {
    const key = `${cid}:${frameIdx}`;
    if (this._boundsCache.has(key)) return this._boundsCache.get(key);
    const sc = String(cid);
    let b = null;
    if (this.data.shapes[sc]) {
      const s = this.data.shapes[sc];
      b = s.bounds || s.b1;
    } else if (this.data.texts[sc]) {
      b = this.data.texts[sc].bounds;
    } else if (this.data.editTexts[sc]) {
      b = this.data.editTexts[sc].bounds;
    } else if (this.data.buttons[sc]) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const rec of this.data.buttons[sc]) {
        if (!rec.hit && !rec.up) continue;
        const cb = this.getBounds(rec.cid, 0);
        if (!cb) continue;
        const tb = this._transformBounds(cb, rec.m);
        if (tb[0] < minX) minX = tb[0];
        if (tb[1] > maxX) maxX = tb[1];
        if (tb[2] < minY) minY = tb[2];
        if (tb[3] > maxY) maxY = tb[3];
      }
      if (minX < Infinity) b = [minX, maxX, minY, maxY];
    } else if (this.data.sprites[sc]) {
      const frs = this.data.sprites[sc].frames;
      if (frs && frs.length) {
        const fr = frs[Math.min(frameIdx, frs.length - 1)];
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const it of fr) {
          const cb = this.getBounds(it.cid, 0);
          if (!cb) continue;
          const tb = it.m ? this._transformBounds(cb, it.m) : cb;
          if (tb[0] < minX) minX = tb[0];
          if (tb[1] > maxX) maxX = tb[1];
          if (tb[2] < minY) minY = tb[2];
          if (tb[3] > maxY) maxY = tb[3];
        }
        if (minX < Infinity) b = [minX, maxX, minY, maxY];
      }
    }
    this._boundsCache.set(key, b);
    return b;
  }

  getButtonHitBounds(cid) {
    const recs = this.data.buttons[String(cid)];
    if (!recs) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const rec of recs) {
      if (!rec.hit) continue;
      const cb = this.getBounds(rec.cid, 0);
      if (!cb) continue;
      const tb = this._transformBounds(cb, rec.m);
      if (tb[0] < minX) minX = tb[0];
      if (tb[1] > maxX) maxX = tb[1];
      if (tb[2] < minY) minY = tb[2];
      if (tb[3] > maxY) maxY = tb[3];
    }
    return minX < Infinity ? [minX, maxX, minY, maxY] : this.getBounds(cid, 0);
  }

  _transformBounds(b, m) {
    if (!m) return b;
    const pts = [
      [b[0], b[2]],
      [b[1], b[2]],
      [b[0], b[3]],
      [b[1], b[3]],
    ];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      const nx = x * m.sx + y * m.r1 + m.tx;
      const ny = x * m.r0 + y * m.sy + m.ty;
      if (nx < minX) minX = nx;
      if (nx > maxX) maxX = nx;
      if (ny < minY) minY = ny;
      if (ny > maxY) maxY = ny;
    }
    return [minX, maxX, minY, maxY];
  }

  _traceSubpaths(ctx, subpaths) {
    ctx.beginPath();
    for (let i = 0; i < subpaths.length; i++) {
      const sp = subpaths[i];
      if (!sp.length) continue;
      ctx.moveTo(sp[0][0], sp[0][1]);
      for (let j = 1; j < sp.length; j++) {
        const seg = sp[j];
        if (seg[0] === 'L') {
          ctx.lineTo(seg[1], seg[2]);
        } else {
          ctx.quadraticCurveTo(seg[1], seg[2], seg[3], seg[4]);
        }
      }
    }
  }

  _drawShapeGroups(ctx, groups, cx, clipOnly = false, allowSeamSeal = false) {
    if (clipOnly) {
      ctx.beginPath();
      for (const g of groups) {
        for (const fp of g.fills) {
          for (const sp of fp.subpaths) {
            if (!sp.length) continue;
            ctx.moveTo(sp[0][0], sp[0][1]);
            for (let j = 1; j < sp.length; j++) {
              const seg = sp[j];
              if (seg[0] === 'L') ctx.lineTo(seg[1], seg[2]);
              else ctx.quadraticCurveTo(seg[1], seg[2], seg[3], seg[4]);
            }
          }
        }
      }
      ctx.clip();
      return;
    }

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const sealSeams = allowSeamSeal && g.fills.length > 1 && g.lines.length === 0;
      for (let fi = 0; fi < g.fills.length; fi++) {
        const fp = g.fills[fi];
        const st = fp.style;
        if (st.type === 'solid') {
          this._traceSubpaths(ctx, fp.subpaths);
          const solidCol = applyCxToColor(st.c, cx);
          ctx.fillStyle = solidCol;
          ctx.fill('evenodd');
          if (sealSeams && st.c[3] >= 250) {
            ctx.strokeStyle = solidCol;
            ctx.lineWidth = 0.55;
            ctx.lineJoin = 'round';
            ctx.stroke();
          }
        } else if (st.type === 'linear') {
          const m = st.m;
          const x0 = -819.2 * m.sx + m.tx;
          const y0 = -819.2 * m.r0 + m.ty;
          const x1 = 819.2 * m.sx + m.tx;
          const y1 = 819.2 * m.r0 + m.ty;
          const grad = ctx.createLinearGradient(x0, y0, x1, y1);
          for (const stop of st.stops) {
            grad.addColorStop(stop.r / 255, applyCxToColor(stop.c, cx));
          }
          this._traceSubpaths(ctx, fp.subpaths);
          ctx.fillStyle = grad;
          ctx.fill('evenodd');
        } else if (st.type === 'radial') {
          const m = st.m;
          ctx.save();
          this._traceSubpaths(ctx, fp.subpaths);
          ctx.clip('evenodd');
          ctx.transform(m.sx, m.r0, m.r1, m.sy, m.tx, m.ty);
          const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 819.2);
          for (const stop of st.stops) {
            grad.addColorStop(stop.r / 255, applyCxToColor(stop.c, cx));
          }
          ctx.fillStyle = grad;
          ctx.fillRect(-1000, -1000, 2000, 2000);
          ctx.restore();
        } else if (st.type === 'bitmap') {
          const img = this.images.get(st.bid);
          if (img) {
            ctx.save();
            if (cx && cx.ma !== 1) ctx.globalAlpha *= Math.max(0, Math.min(1, cx.ma));
            this._traceSubpaths(ctx, fp.subpaths);
            ctx.clip('evenodd');
            const m = st.m;
            ctx.transform(m.sx / 20, m.r0 / 20, m.r1 / 20, m.sy / 20, m.tx, m.ty);
            ctx.drawImage(img, 0, 0);
            ctx.restore();
          }
        }
      }
      for (let li = 0; li < g.lines.length; li++) {
        const lp = g.lines[li];
        const st = lp.style;
        this._traceSubpaths(ctx, lp.subpaths);
        ctx.strokeStyle = applyCxToColor(st.c, cx);
        ctx.lineWidth = Math.max(0.75, st.w || 1);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
    }
  }

  _getMorphGroups(cid, shape, ratio) {
    const t = Math.max(0, Math.min(1, (ratio || 0) / 65535));
    if (t <= 0.001) return shape.startGroups;
    if (t >= 0.999) return shape.endGroups;
    const bucket = Math.round(t * 24);
    const key = `${cid}:${bucket}`;
    const cached = this._morphCache.get(key);
    if (cached) return cached;

    const bt = bucket / 24;
    const fillStyles = shape.fills.map((f) => {
      if (f.type === 'solid') return { type: 'solid', c: lerpColor(f.c1, f.c2, bt) };
      if (f.type === 'linear' || f.type === 'radial') {
        return {
          type: f.type,
          m: lerpMatrix(f.m, f.m2, bt),
          stops: f.stops.map((s) => ({
            r: Math.round(lerp(s.r1, s.r2, bt)),
            c: lerpColor(s.c1, s.c2, bt),
          })),
        };
      }
      return f;
    });
    const lineStyles = shape.lines.map((l) => ({
      w: lerp(l.w1, l.w2, bt),
      c: lerpColor(l.c1, l.c2, bt),
    }));

    const fillEdges = new Map();
    const lineEdges = new Map();
    const e1 = shape.e1;
    const e2 = shape.e2;
    const n = Math.min(e1.length, e2.length);
    for (let i = 0; i < n; i++) {
      const a = e1[i], b = e2[i];
      const f0 = a[a.length - 3], f1 = a[a.length - 2], ls = a[a.length - 1];
      let seg;
      if (a[0] === 0 && b[0] === 0) {
        seg = ['L', lerp(a[1], b[1], bt), lerp(a[2], b[2], bt), lerp(a[3], b[3], bt), lerp(a[4], b[4], bt)];
      } else {
        const ax0 = a[1], ay0 = a[2];
        const acx = a[0] === 1 ? a[3] : (a[1] + a[3]) / 2;
        const acy = a[0] === 1 ? a[4] : (a[2] + a[4]) / 2;
        const ax1 = a[0] === 1 ? a[5] : a[3];
        const ay1 = a[0] === 1 ? a[6] : a[4];

        const bx0 = b[1], by0 = b[2];
        const bcx = b[0] === 1 ? b[3] : (b[1] + b[3]) / 2;
        const bcy = b[0] === 1 ? b[4] : (b[2] + b[4]) / 2;
        const bx1 = b[0] === 1 ? b[5] : b[3];
        const by1 = b[0] === 1 ? b[6] : b[4];

        seg = [
          'Q',
          lerp(ax0, bx0, bt), lerp(ay0, by0, bt),
          lerp(acx, bcx, bt), lerp(acy, bcy, bt),
          lerp(ax1, bx1, bt), lerp(ay1, by1, bt),
        ];
      }
      if (f1 > 0) {
        if (!fillEdges.has(f1)) fillEdges.set(f1, []);
        fillEdges.get(f1).push(seg);
      }
      if (f0 > 0) {
        if (!fillEdges.has(f0)) fillEdges.set(f0, []);
        const rev = seg[0] === 'L'
          ? ['L', seg[3], seg[4], seg[1], seg[2]]
          : ['Q', seg[5], seg[6], seg[3], seg[4], seg[1], seg[2]];
        fillEdges.get(f0).push(rev);
      }
      if (ls > 0) {
        if (!lineEdges.has(ls)) lineEdges.set(ls, []);
        lineEdges.get(ls).push(seg);
      }
    }

    const fills = [];
    for (const [fidx, eds] of [...fillEdges.entries()].sort((x, y) => x[0] - y[0])) {
      if (fillStyles[fidx - 1]) {
        fills.push({ style: fillStyles[fidx - 1], subpaths: stitchMorphEdges(eds) });
      }
    }
    const lines = [];
    for (const [lidx, eds] of [...lineEdges.entries()].sort((x, y) => x[0] - y[0])) {
      if (lineStyles[lidx - 1]) {
        lines.push({ style: lineStyles[lidx - 1], subpaths: stitchMorphEdges(eds) });
      }
    }
    const groups = [{ fills, lines }];
    this._morphCache.set(key, groups);
    return groups;
  }

  drawShape(ctx, cid, cx = IDENTITY_CX, ratio = 0, clipOnly = false) {
    const sh = this.data.shapes[String(cid)];
    if (!sh) return;
    const b = sh.bounds || sh.b1;
    const large = b ? (b[1] - b[0] > 40 || b[3] - b[2] > 40) : false;
    if (sh.morph) {
      const groups = this._getMorphGroups(cid, sh, ratio);
      this._drawShapeGroups(ctx, groups, cx, clipOnly, large);
    } else {
      this._drawShapeGroups(ctx, sh.groups, cx, clipOnly, large);
    }
  }

  drawText(ctx, cid, cx = IDENTITY_CX) {
    const td = this.data.texts[String(cid)];
    if (!td) return;
    ctx.save();
    const m = td.m;
    if (m) ctx.transform(m.sx, m.r0, m.r1, m.sy, m.tx, m.ty);
    for (const rec of td.records) {
      const font = this.data.fonts[String(rec.font)];
      if (!font) continue;
      const scale = rec.h / 51.2;
      const fillStr = applyCxToColor(rec.color, cx);
      let penX = rec.x;
      const penY = rec.y;
      for (const [gi, adv] of rec.glyphs) {
        const glyphGroups = font.glyphs[gi];
        if (glyphGroups && glyphGroups.length) {
          ctx.save();
          ctx.translate(penX, penY);
          ctx.scale(scale, scale);
          ctx.fillStyle = fillStr;
          for (const g of glyphGroups) {
            for (const fp of g.fills) {
              this._traceSubpaths(ctx, fp.subpaths);
              ctx.fill('evenodd');
            }
          }
          ctx.restore();
        }
        penX += adv;
      }
    }
    ctx.restore();
  }

  drawEditText(ctx, cid, cx = IDENTITY_CX, vars = null) {
    const et = this.data.editTexts[String(cid)];
    if (!et) return;
    let text = '';
    if (vars && et.var && et.var in vars) {
      text = String(vars[et.var] ?? '');
    } else if (et.init) {
      text = et.init.replace(/<[^>]*>/g, '');
    }

    const b = et.bounds;
    const h = et.h || 11;
    const fillStr = applyCxToColor(et.color, cx);

    if (et.border) {
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1;
      ctx.fillRect(b[0], b[2], b[1] - b[0], b[3] - b[2]);
      ctx.strokeRect(b[0], b[2], b[1] - b[0], b[3] - b[2]);
      ctx.restore();
    }

    if (!text) return;

    // Render using embedded vector outline font when outlines=true
    const font = et.font != null ? this.data.fonts[String(et.font)] : null;
    const cmap = et.font != null ? this._fontCodeMaps.get(String(et.font)) : null;
    if (et.outlines && font && font.glyphs && font.glyphs.length && cmap) {
      const emScale = h / 1024;
      const glyphScale = h / 51.2;
      const ascentPx = (font.ascent ?? 850) * emScale;
      const glyphsToDraw = [];
      let totalW = 0;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        let gi = cmap.get(ch.charCodeAt(0));
        if (gi === undefined) gi = cmap.get(ch.toUpperCase().charCodeAt(0));
        if (gi === undefined) {
          totalW += 368 * emScale;
          glyphsToDraw.push({ gi: -1, adv: 368 * emScale });
          continue;
        }
        const adv = ((font.advances && font.advances[gi] != null) ? font.advances[gi] : 450) * emScale;
        glyphsToDraw.push({ gi, adv });
        totalW += adv;
      }

      let penX = b[0] + 2;
      if (et.align === 2) {
        penX = (b[0] + b[1]) / 2 - totalW / 2;
      } else if (et.align === 1) {
        penX = b[1] - 2 - totalW;
      }
      const penY = b[2] + 2 + ascentPx;

      ctx.save();
      ctx.beginPath();
      ctx.rect(b[0], b[2], b[1] - b[0], b[3] - b[2]);
      ctx.clip();
      ctx.fillStyle = fillStr;
      for (const item of glyphsToDraw) {
        if (item.gi >= 0) {
          const glyphGroups = font.glyphs[item.gi];
          if (glyphGroups && glyphGroups.length) {
            ctx.save();
            ctx.translate(penX, penY);
            ctx.scale(glyphScale, glyphScale);
            for (const g of glyphGroups) {
              for (const fp of g.fills) {
                this._traceSubpaths(ctx, fp.subpaths);
                ctx.fill('evenodd');
              }
            }
            ctx.restore();
          }
        }
        penX += item.adv;
      }
      ctx.restore();
      return;
    }

    // Standard sans-serif dynamic text field with bounds clipping
    ctx.save();
    ctx.beginPath();
    ctx.rect(b[0], b[2], b[1] - b[0], b[3] - b[2]);
    ctx.clip();
    const fontPx = h * 1.07;
    ctx.font = `${fontPx.toFixed(2)}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle = fillStr;
    ctx.textBaseline = 'top';
    let tx = b[0] + 2;
    if (et.align === 2) {
      ctx.textAlign = 'center';
      tx = (b[0] + b[1]) / 2;
    } else if (et.align === 1) {
      ctx.textAlign = 'right';
      tx = b[1] - 2;
    } else {
      ctx.textAlign = 'left';
    }
    ctx.fillText(text, tx, b[2] + 5.0);
    ctx.restore();
  }

  drawButton(ctx, cid, cx = IDENTITY_CX, state = 'up', vars = null) {
    const recs = this.data.buttons[String(cid)];
    if (!recs) return;
    const sorted = [...recs].sort((a, b) => a.depth - b.depth);
    for (const rec of sorted) {
      const show = (state === 'down' && rec.down) || (state === 'over' && rec.over) || (state === 'up' && rec.up);
      if (!show) continue;
      ctx.save();
      if (rec.m) ctx.transform(rec.m.sx, rec.m.r0, rec.m.r1, rec.m.sy, rec.m.tx, rec.m.ty);
      const childCx = concatCx(cx, parseCx(rec.cx));
      this.drawChar(ctx, rec.cid, { cx: childCx, vars });
      ctx.restore();
    }
  }

  drawChar(ctx, cid, opts = {}) {
    const sc = String(cid);
    const cx = opts.cx || IDENTITY_CX;
    if (this.data.shapes[sc]) {
      this.drawShape(ctx, cid, cx, opts.ratio || 0, opts.clipOnly || false);
    } else if (this.data.texts[sc]) {
      this.drawText(ctx, cid, cx);
    } else if (this.data.editTexts[sc]) {
      this.drawEditText(ctx, cid, cx, opts.vars || null);
    } else if (this.data.buttons[sc]) {
      const bState = opts.buttonStates?.[cid] || 'up';
      this.drawButton(ctx, cid, cx, bState, opts.vars || null);
    } else if (this.data.sprites[sc]) {
      this.drawSprite(ctx, cid, opts);
    }
  }

  drawSprite(ctx, cidOrName, opts = {}) {
    const cid = typeof cidOrName === 'string' ? this.getExportId(cidOrName) : cidOrName;
    if (cid == null) return;
    const sp = this.data.sprites[String(cid)];
    if (!sp || !sp.frames.length) return;
    const frameIdx = Math.max(0, Math.min(sp.frames.length - 1, opts.frame || 0));
    const items = sp.frames[frameIdx];
    const baseCx = opts.cx || IDENTITY_CX;
    const overrides = opts.overrides || null;
    const skipCids = opts.skipCids || null;

    let clipUntilDepth = -1;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (clipUntilDepth >= 0 && it.depth > clipUntilDepth) {
        ctx.restore();
        clipUntilDepth = -1;
      }
      if (skipCids && skipCids.has(it.cid)) continue;

      const ov = overrides && ((it.name && overrides[it.name]) || overrides[`#${it.cid}`] || overrides[`@${it.depth}`]);
      if (ov && ov.visible === false) continue;

      if (it.clip) {
        ctx.save();
        if (it.m) ctx.transform(it.m.sx, it.m.r0, it.m.r1, it.m.sy, it.m.tx, it.m.ty);
        this.drawChar(ctx, it.cid, { clipOnly: true });
        if (it.m) {
          const det = it.m.sx * it.m.sy - it.m.r0 * it.m.r1;
          if (Math.abs(det) > 1e-9) {
            const isx = it.m.sy / det;
            const ir0 = -it.m.r0 / det;
            const ir1 = -it.m.r1 / det;
            const isy = it.m.sx / det;
            const itx = -(isx * it.m.tx + ir1 * it.m.ty);
            const ity = -(ir0 * it.m.tx + isy * it.m.ty);
            ctx.transform(isx, ir0, ir1, isy, itx, ity);
          }
        }
        clipUntilDepth = it.clip;
        continue;
      }

      ctx.save();
      const m = it.m;
      if (ov && (ov.x !== undefined || ov.y !== undefined || ov.rotation !== undefined || ov.xscale !== undefined || ov.yscale !== undefined)) {
        const tx = ov.x !== undefined ? ov.x : (m ? m.tx : 0);
        const ty = ov.y !== undefined ? ov.y : (m ? m.ty : 0);
        const baseSx = m ? m.sx : 1;
        const baseSy = m ? m.sy : 1;
        const sx = ov.xscale !== undefined ? ov.xscale : baseSx;
        const sy = ov.yscale !== undefined ? ov.yscale : baseSy;
        ctx.translate(tx, ty);
        if (ov.rotation) ctx.rotate((ov.rotation * Math.PI) / 180);
        ctx.scale(sx, sy);
      } else if (m) {
        ctx.transform(m.sx, m.r0, m.r1, m.sy, m.tx, m.ty);
      }

      let childCx = concatCx(baseCx, parseCx(it.cx));
      if (ov && ov.cx) childCx = concatCx(childCx, ov.cx);
      if (ov && ov.alpha !== undefined) childCx = concatCx(childCx, alphaCx(ov.alpha));

      const childOpts = {
        cx: childCx,
        ratio: it.ratio || 0,
        frame: ov?.frame ?? 0,
        vars: ov?.vars ?? opts.vars ?? null,
        overrides: ov?.overrides ?? null,
        buttonStates: ov?.buttonStates ?? opts.buttonStates ?? null,
        skipCids: ov?.skipCids ?? null,
      };
      this.drawChar(ctx, it.cid, childOpts);

      if (ov && ov.afterDraw) {
        ov.afterDraw(ctx, this);
      }
      ctx.restore();
    }
    if (clipUntilDepth >= 0) {
      ctx.restore();
    }
  }
}
