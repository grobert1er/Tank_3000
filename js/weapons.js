// Projectile ballistics, rollers (V1 downhill & V2 uphill), cluster bombs, air strike, and explosions

import { STAGE_W, STAGE_H, WEAPONS, SUB_WEAPONS, SOUNDS } from './constants.js';

export class Projectile {
  constructor(opts) {
    this.spec = opts.spec; // weapon or sub-weapon config
    this.owner = opts.owner; // Tank instance
    this.isSub = Boolean(opts.isSub);
    this.subIndex = opts.subIndex ?? 0;
    this.parentProj = opts.parentProj || null;

    this.x0 = opts.x;
    this.y0 = opts.y;
    this.x = opts.x;
    this.y = opts.y;
    this.parentRot = opts.parentRot ?? 0; // rotace - 90
    this.uhel = opts.uhel !== undefined ? opts.uhel : (-this.parentRot + 90);
    this.vo = opts.vo ?? 50;
    this.g = 9.81;
    this.t = opts.t ?? 0;
    this.tStep = opts.tStep ?? 0.1;
    this.inc = opts.inc ?? 0; // lateral spread for Shower / Hot shower clusters
    this.noWind = Boolean(opts.noWind);

    if (opts.vox !== undefined && opts.voy !== undefined) {
      this.vox = opts.vox;
      this.voy = opts.voy;
    } else {
      // Initial launch velocity components
      this.vox = Math.cos((Math.PI / 180) * this.uhel) * this.vo;
      this.voy = Math.sin(0.017 * this.uhel) * this.vo;
    }

    this.hit = true; // true until projectile exits owner tank/shield
    this.frame = 1; // 1 = flying, 2..12 = exploding, 12..14 = waiting for sub-shots
    this.exploding = false;
    this.done = false;
    this.waitingForSubs = false;
    this.endEarly = false;
    this.subDone = [];
    this.expectedSubs = 0;

    // Roller state (V1 downhill / V2 uphill)
    this.isRoller = this.spec.kind === 'roller';
    this.uphill = Boolean(this.spec.uphill);
    this.first = true;  // airborne phase
    this.second = false; // rolling phase
    this.rollStart = true;
    this.smer = null; // 'left' | 'right'
  }

  _startExplosion(game) {
    if (this.exploding) return;
    this.exploding = true;
    this.first = false;
    this.second = false;
    this.frame = 2;
    game.sound.play(this.spec.soundId, { volume: 0.9, minIntervalMs: 30 });
  }

  // Exact bum() formula from Sprites 37/40/42/44/47/49/51/53/55/58/61/66/68
  _bum(game) {
    const s = this.spec;
    game.terrain.carveExplosion(this.x, this.y, s.f6w, s.f6h, s.par1, s.par2, s.par3);

    if (this.owner) {
      this.owner.lastShotX = this.x;
      this.owner.lastShotY = this.y;
      this.owner.lastShotOut = false;
    }

    for (const tank of game.tanks) {
      if (!tank.data.live) continue;
      if (tank.hitTestExplosion(this.x, this.y, s.f6w / 2, s.f6h / 2)) {
        const dx = this.x - tank.x;
        const dy = this.y - tank.y;
        const vzd = Math.sqrt(dx * dx + dy * dy);
        let damg;
        if (!tank.shActive) {
          damg = Math.round(s.f6w / ((vzd + 1) / s.par4));
          if (tank.data.energy < damg) damg = tank.data.energy;
        } else {
          damg = Math.round(s.f6w / ((vzd / 2 + 1) / s.par5));
        }
        tank.damage(damg, this.owner, false);
      }
    }
  }

  // Volcano bomb Frame 4 burst (5 missile_funky sub-shots)
  _spawnVolcanoSubs(game) {
    this.expectedSubs = 5;
    this.subDone = [false, false, false, false, false];
    for (let i = 0; i < 5; i++) {
      const rot = game.rng.random(90) - 45;
      const vo = game.rng.random(30) + 15;
      const sub = new Projectile({
        spec: SUB_WEAPONS.missile_funky,
        owner: this.owner,
        isSub: true,
        subIndex: i,
        parentProj: this,
        x: this.x,
        y: this.y - 5,
        parentRot: rot,
        vo,
        t: 0,
        inc: 0,
      });
      game.projectiles.push(sub);
    }
  }

  // Shower (5 missile_funky) and Hot shower (7 bnuke_c) mid-air split at t == 3.0
  _spawnShowerSubs(game, count, subKey) {
    this.expectedSubs = count;
    this.subDone = new Array(count).fill(false);
    const half = Math.floor(count / 2); // 2 for Shower(5), 3 for Hot shower(7)
    for (let i = 0; i < count; i++) {
      const sub = new Projectile({
        spec: SUB_WEAPONS[subKey],
        owner: this.owner,
        isSub: true,
        subIndex: i,
        parentProj: this,
        x: this.x0 + game.terrain.vitr / 7,
        y: this.y0,
        parentRot: this.parentRot,
        vo: this.vo,
        vox: this.vox,
        voy: this.voy,
        t: this.t,
        inc: -half + i,
      });
      sub.x = this.x;
      sub.y = this.y;
      sub.hit = false;
      game.projectiles.push(sub);
    }
  }

  _finish(game) {
    this.done = true;
    if (this.isSub && this.parentProj) {
      this.parentProj.subDone[this.subIndex] = true;
    } else if (!this.isSub) {
      game.shotFlying = false;
      game.triggerTest();
    }
  }

  tick(game) {
    if (this.done) return;

    // Waiting for sub-munitions to finish (Volcano / Shower / Hot shower frames 12..14)
    if (this.waitingForSubs) {
      const allDone = this.endEarly || this.subDone.every(Boolean);
      if (allDone) {
        this._finish(game);
      }
      return;
    }

    // Explosion timeline (Frames 2..12)
    if (this.exploding) {
      if (this.frame === 4 && this.spec.kind === 'funky') {
        this._spawnVolcanoSubs(game);
      }
      if (this.frame === 6) {
        this._bum(game);
      }
      this.frame++;
      if (this.frame >= 12) {
        if (this.spec.kind === 'funky' || this.spec.kind === 'mirv' || this.spec.kind === 'death') {
          if (this.expectedSubs === 0) {
            // Exploded before t==3.0 split -> no sub-munitions spawned
            this.endEarly = true;
          }
          this.waitingForSubs = true;
        } else {
          this._finish(game);
        }
      }
      return;
    }

    // Out-of-bounds check
    const oob = this.noWind
      ? (this.y > STAGE_H)
      : (this.x < 0 || this.x > STAGE_W || this.y > STAGE_H);
    if (oob) {
      if (!this.isSub && !this.isRoller && this.owner) {
        this.owner.lastShotX = this.x;
        this.owner.lastShotY = this.y;
        this.owner.lastShotOut = true;
      }
      if ((this.spec.kind === 'mirv' || this.spec.kind === 'death') && this.expectedSubs > 0) {
        this.waitingForSubs = true;
      } else {
        this._finish(game);
      }
      return;
    }

    // Tank / shield collision check
    for (const tank of game.tanks) {
      if (!tank.data.live) continue;
      if (this.noWind) {
        // Air strike amissile hits any tank/shield directly
        if (tank.hitTestProjectile(this.x, this.y, 1.5, 1.5, true)) {
          this._startExplosion(game);
          return;
        }
      } else {
        if (tank.tankNumber !== this.owner.tankNumber) {
          if (tank.hitTestProjectile(this.x, this.y, 1.5, 1.5, true)) {
            this._startExplosion(game);
            return;
          }
        } else if (!this.hit && tank.hitTestProjectile(this.x, this.y, 1.5, 1.5, true)) {
          this._startExplosion(game);
          return;
        }
      }
    }

    // Clear self-protection flag once projectile leaves owner & owner's shield
    if (this.hit && this.owner && !this.owner.hitTestProjectile(this.x, this.y, 1.5, 1.5, true)) {
      this.hit = false;
    }

    if (this.isRoller) {
      this._tickRoller(game);
      return;
    }

    // Standard / cluster / air-strike ballistic motion
    this.x = this.x0 + this.vox * this.t;
    this.y = this.y0 - this.voy * this.t + (this.g / 2) * (this.t * this.t);
    if (!this.noWind) {
      this.vox += game.terrain.vitr / 600;
    }
    if (this.inc !== 0) {
      this.vox += this.inc / 20;
    }

    // Terrain collision
    if (this.x >= 0 && this.x < STAGE_W && game.terrain.hitPoint(this.x, this.y, 1.5)) {
      this._startExplosion(game);
      return;
    }

    // Shower & Hot shower mid-air split at exactly t == 3.0
    if ((this.spec.kind === 'mirv' || this.spec.kind === 'death') && Math.round(this.t * 10) / 10 === 3) {
      if (this.spec.kind === 'mirv') {
        this._spawnShowerSubs(game, 5, 'missile_funky');
      } else {
        this._spawnShowerSubs(game, 7, 'bnuke_c');
      }
    }

    this.t += this.tStep;
  }

  // Exact V1 (downhill) and V2 (uphill) roller mechanics from Sprites 56-63
  _tickRoller(game) {
    if (this.first) {
      this.x = this.x0 + this.vox * this.t;
      this.y = this.y0 - this.voy * this.t + (this.g / 2) * (this.t * this.t);
      this.vox += game.terrain.vitr / 600;
      if (this.x >= 0 && this.x < STAGE_W && game.terrain.hitPoint(this.x, this.y, 1.5)) {
        this.first = false;
        this.second = true;
      }
      this.t += 0.1;
    }

    if (this.second) {
      const lastx = Math.round(this.x);
      const ix = Math.round(this.x);
      if (ix <= 1 || ix >= STAGE_W - 2) {
        this._finish(game);
        return;
      }
      const cury = game.terrain.topY(ix);
      const curly = game.terrain.topY(ix - 1);
      const curpy = game.terrain.topY(ix + 1);
      this.y = cury;

      if (this.rollStart) {
        if (!this.uphill) {
          // V1 (broller/roller/hroller): rolls DOWNHILL (larger Y = lower)
          // If both neighbors are higher (curly < cury && curpy < cury), explode in valley
          if (curly < cury && curpy < cury) {
            this._startExplosion(game);
            return;
          }
          if (!(curly < cury)) {
            this.smer = 'left';
          } else if (!(curpy < cury)) {
            this.smer = 'right';
          }
        } else {
          // V2 (broller2/roller2/hroller2): rolls UPHILL (smaller Y = higher)
          // If both neighbors are lower (cury < curly && cury < curpy), explode on peak
          if (cury < curly && cury < curpy) {
            this._startExplosion(game);
            return;
          }
          if (!(curly < cury)) {
            this.smer = 'right';
          } else if (!(curpy < cury)) {
            this.smer = 'left';
          }
        }
        this.rollStart = false;
      }

      if (this.smer === 'left') {
        const ny = game.terrain.topY(ix - 1);
        const canContinue = this.uphill ? !(cury < ny) : !(ny < cury);
        if (canContinue) {
          this.x -= 1;
        } else {
          this._startExplosion(game);
          return;
        }
      } else if (this.smer === 'right') {
        const ny = game.terrain.topY(ix + 1);
        const canContinue = this.uphill ? !(cury < ny) : !(ny < cury);
        if (canContinue) {
          this.x += 1;
        } else {
          this._startExplosion(game);
          return;
        }
      }

      if (Math.round(lastx) === Math.round(this.x)) {
        this.smer = this.owner && this.owner.x < this.x ? 'right' : 'left';
      }
    }
  }

  render(ctx, renderer) {
    if (this.done || this.waitingForSubs) return;
    ctx.save();
    ctx.translate(this.x, this.y);
    if (!this.exploding) {
      ctx.rotate((this.parentRot * Math.PI) / 180);
      renderer.drawSprite(ctx, this.spec.spriteId, { frame: 0 });
    } else {
      renderer.drawSprite(ctx, this.spec.spriteId, { frame: Math.min(11, this.frame - 1) });
    }
    ctx.restore();
  }
}

// Air strike controller (Sprite 64/65): wait for mouse click, then drop 5 amissiles
export class AirStrikeController {
  constructor(owner) {
    this.owner = owner;
    this.launched = false;
    this.uhel = 0; // 0 = flying right (cursor xscale=+1), 180 = flying left (xscale=-1)
    this.cursorX = 275;
    this.cursorY = 120;
    this.subDone = [false, false, false, false, false];
    this.done = false;
  }

  setDirection(dir) {
    if (this.launched) return;
    this.uhel = dir === 'right' ? 180 : 0;
  }

  launch(game, targetX) {
    if (this.launched) return;
    this.launched = true;
    game.sound.play(SOUNDS.NUKE_EXPLODE, { volume: 0.65, minIntervalMs: 30 });
    for (let i = 0; i < 5; i++) {
      const startX = this.uhel === 0
        ? (targetX - 120 + i * 20)
        : (targetX + 120 - i * 20);
      const sub = new Projectile({
        spec: SUB_WEAPONS.amissile,
        owner: this.owner,
        isSub: true,
        subIndex: i,
        parentProj: this,
        x: startX,
        y: -50,
        uhel: this.uhel,
        parentRot: this.uhel === 0 ? 0 : 180,
        vo: 10,
        t: 0,
        tStep: 0.12,
        noWind: true,
      });
      sub.hit = false;
      game.projectiles.push(sub);
    }
  }

  tick(game) {
    if (this.done || !this.launched) return;
    if (this.subDone.every(Boolean)) {
      this.done = true;
      game.shotFlying = false;
      game.triggerTest();
    }
  }

  render(ctx, renderer) {
    if (this.launched || this.done) return;
    ctx.save();
    ctx.translate(this.cursorX, this.cursorY);
    if (this.uhel === 180) ctx.scale(-1, 1);
    renderer.drawSprite(ctx, 'astrikecur');
    ctx.restore();
  }
}

// Teleport animation controller (Sprite 305: 48 frames)
export class TeleportController {
  constructor(tank) {
    this.tank = tank;
    this.picked = false;
    this.cursorX = tank.x;
    this.cursorY = tank.y;
    this.tarX = tank.x;
    this.tarY = tank.y;
    this.x = tank.x;
    this.y = tank.y;
    this.frame = 1; // 1 = aiming cursor, 2..48 = animation
    this.done = false;
  }

  confirm(x, y) {
    if (this.picked) return;
    this.picked = true;
    this.tarX = Math.max(12, Math.min(STAGE_W - 12, x));
    this.tarY = Math.max(60, Math.min(STAGE_H - 12, y));
    this.x = this.tarX;
    this.y = this.tarY;
    this.frame = 2;
  }

  tick(game) {
    if (this.done || !this.picked) return;
    this.frame++;
    if (this.frame === 10) {
      this.x = this.tank.x;
      this.y = this.tank.y;
    } else if (this.frame === 17) {
      this.tank.visible = false;
    } else if (this.frame === 35) {
      this.x = this.tarX;
      this.y = this.tarY;
    } else if (this.frame === 41) {
      this.tank.visible = true;
      this.tank.x = this.x;
      this.tank.y = this.y;
      this.tank.fall = 0;
    } else if (this.frame >= 48) {
      this.done = true;
      game.triggerTest();
    }
  }

  render(ctx, renderer) {
    if (this.done) return;
    ctx.save();
    if (!this.picked) {
      ctx.translate(this.cursorX, this.cursorY);
      renderer.drawSprite(ctx, 'teleport_a', { frame: 0 });
    } else {
      ctx.translate(this.x, this.y);
      renderer.drawSprite(ctx, 'teleport_a', { frame: Math.min(47, this.frame - 1) });
    }
    ctx.restore();
  }
}

export function getWeaponSpec(gunIdx) {
  return WEAPONS[gunIdx] || WEAPONS[0];
}
