// Tank entity physics, damage, armor, shields, parachutes, and death explosion

import {
  STAGE_W, STAGE_H,
  TANK_WIDTH, TANK_HEIGHT, TANK_HALF_W, TANK_HALF_H,
  TANK_PASY_LEFT, TANK_PASY_RIGHT, TANK_PASY_TOP, TANK_PASY_BOTTOM,
  TANK_DEATH_EXPL_W, TANK_DEATH_EXPL_H,
  SHIELD_RADIUS, SHIELD_TIERS, SOUNDS,
  MAX_UPGRADE_LEVEL, LEADER_BOUNTY, getMaxPower,
} from './constants.js';

function hexIntToRgb(hex) {
  return [(hex >> 16) & 0xFF, (hex >> 8) & 0xFF, hex & 0xFF];
}

function rgbStr([r, g, b], a = 1) {
  return a < 1 ? `rgba(${r},${g},${b},${a})` : `rgb(${r},${g},${b})`;
}

function tintRgb([r, g, b], delta) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(r + delta), clamp(g + delta), clamp(b + delta)];
}

const SHIELD_COLORS = {
  1: { fill: 'rgba(56, 189, 248, 0.14)', stroke: '#38bdf8' },
  2: { fill: 'rgba(14, 165, 233, 0.16)', stroke: '#0284c7' },
  3: { fill: 'rgba(99, 102, 241, 0.16)', stroke: '#6366f1' },
  4: { fill: 'rgba(139, 92, 246, 0.18)', stroke: '#8b5cf6' },
};

export class Tank {
  constructor(data, x, terrain, rng, flatten = true) {
    this.data = data; // persistent player record
    this.tankNumber = data.t_num;
    this.type = data.type; // 'tank' | 'ai'
    this.dif = data.dif;

    this.x = x;
    this.y = terrain.topY(Math.round(x)) - 4;
    if (flatten) {
      terrain.flattenUnderTank(this.x, this.y, TANK_WIDTH, TANK_HEIGHT);
    }

    this.rotace = rng.random(67) * 2 + 46; // 46..178 even degrees
    this.power = 50;
    this.playing = false;
    this.testing = false;
    this.naZemi = false;
    this.left = true;
    this.right = true;
    this.moving = false;
    this.fall = 0;
    this.fallStartY = null;
    this.parUsedThisFall = false;
    this.hillUp = 0.5;
    this.test = true;
    this.x1 = 0; this.x2 = 0; this.x3 = 0;
    this.y1 = 0; this.y2 = 0; this.y3 = 0;

    // Parachute state
    this.par = data.specials[0] > 0;
    this.parActive = false;
    this.parOut = false;
    this.parUsed = false;

    // Shield state (max 1 activation per round; Weak=50, Shield=100, Strong=175, Super=250)
    this.shActive = false;
    this.shieldUsedThisRound = false;
    this.shieldTier = 0;
    this.shieldEnergy = 0;
    this.shieldMax = 0;
    this.shieldSprite = null;

    // Barrel recoil animation (hlaven: 15 frames, frame 0 = idle)
    this.barrelFrame = 0;
    this.barrelPlaying = false;

    // Visibility (hidden during teleport frames 17..40)
    this.visible = true;

    // Death explosion animation (frames 4..15)
    this.dying = false;
    this.dead = false;
    this.deathFrame = 0;

    // Fuel consumption per move step: 1 / (specials[10] + 1)
    this.fuelC = 1 / (Math.min(MAX_UPGRADE_LEVEL, data.specials[10] || 0) + 1);

    // AI tracking fields
    this.lastShotX = this.x;
    this.lastShotY = this.y;
    this.lastShotOut = false;
    this.lastWind = 0;
    this.rounds = 0;
    this.firstShot = true;
    this.firstFrame = true;
    this.target = null;
    this.pRotace = this.rotace;
    this.pPower = this.power;
    this.pX = this.x;
    this.pMove = false;
    this._aiTurnFrames = 0;
  }

  calcHillUp() {
    this.hillUp = 0.5 + Math.min(MAX_UPGRADE_LEVEL, this.data.specials[11] || 0) - this.fall * 10;
  }

  testHill(terrain) {
    this.calcHillUp();
    const leftCeil = terrain.topY(Math.ceil(this.x - TANK_HALF_W));
    const leftFloor = terrain.topY(Math.floor(this.x - TANK_HALF_W));
    if (leftCeil < this.y - this.hillUp || leftFloor < this.y - this.hillUp) {
      this.x += 0.7;
      this.test = false;
      this.left = false;
      this.right = false;
      return;
    }
    const rightFloor = terrain.topY(Math.floor(this.x + TANK_HALF_W));
    const rightCeil = terrain.topY(Math.ceil(this.x + TANK_HALF_W));
    if (rightFloor < this.y - this.hillUp || rightCeil < this.y - this.hillUp) {
      this.left = false;
      this.right = false;
      this.x -= 0.7;
      this.test = false;
      return;
    }
    this.left = true;
    this.right = true;
  }

  moveLeft(tanks) {
    if (this.data.fuel <= 0 || this.x <= 10 || !this.left) return false;
    this.x -= 0.5;
    this.data.fuel = Math.max(0, this.data.fuel - this.fuelC);
    this.moving = true;
    for (const other of tanks) {
      if (other.tankNumber !== this.tankNumber && other.data.live && this.hitTestTank(other)) {
        this.x += 0.6;
      }
    }
    return true;
  }

  moveRight(tanks) {
    if (this.data.fuel <= 0 || this.x >= STAGE_W - 10 || !this.right) return false;
    this.x += 0.5;
    this.data.fuel = Math.max(0, this.data.fuel - this.fuelC);
    this.moving = true;
    for (const other of tanks) {
      if (other.tankNumber !== this.tankNumber && other.data.live && this.hitTestTank(other)) {
        this.x -= 0.6;
      }
    }
    return true;
  }

  activateShield(tier, bypassRoundLimit = false) {
    const spec = SHIELD_TIERS[tier];
    if (!spec) return false;
    if (this.shActive || this.data.specials[spec.specialIdx] <= 0) return false;
    if (!bypassRoundLimit && this.shieldUsedThisRound) return false;
    this.data.specials[spec.specialIdx] -= 1;
    this.shActive = true;
    this.shieldUsedThisRound = true;
    this.shieldTier = tier;
    this.shieldEnergy = spec.maxEnergy;
    this.shieldMax = spec.maxEnergy;
    this.shieldSprite = spec.sprite;
    return true;
  }

  disableShield() {
    this.shActive = false;
    this.shieldTier = 0;
    this.shieldEnergy = 0;
    this.shieldMax = 0;
    this.shieldSprite = null;
  }

  // Shield absorption: awards fair score for shield damage and passes 1x overflow to hull
  damageShield(dam, attacker, game = null) {
    if (!this.data.live || this.data.energy <= 0) return;
    const mult = game?.getDamageMultiplier ? game.getDamageMultiplier() : 1;
    const rawDam = Math.max(0, Math.round(dam * mult));
    if (rawDam <= 0) return;

    const absorbed = Math.min(this.shieldEnergy, rawDam);
    const overflow = Math.max(0, rawDam - this.shieldEnergy);
    this.shieldEnergy -= absorbed;

    if (absorbed > 0) {
      game?.vfx?.spawnPopup(this.x, this.y - 12, `-${absorbed}`, '#0284c7');
      if (attacker && attacker !== this) {
        const pts = Math.round(absorbed * 40);
        attacker.data.score += pts;
        attacker.data.total_score += pts;
      }
    }

    if (this.shieldEnergy <= 0) {
      this.disableShield();
      game?.vfx?.spawnPopup(this.x, this.y - 22, 'SHIELD BREAK', '#0ea5e9');
      if (overflow > 0) {
        // Overflow is already scaled by Sudden Death multiplier; pass alreadyScaled=true
        this.damage(overflow, attacker, false, game, true);
      }
    }
  }

  // Apply hull damage, diminishing-returns armor, Sudden Death scaling, leader bounty & accurate scoring
  damage(damag, attacker, isFall = false, game = null, alreadyScaled = false) {
    if (!this.data.live || this.data.energy <= 0) return;
    const rawInput = Math.max(0, damag);
    if (rawInput <= 0) return;

    if (this.shActive && !isFall) {
      this.damageShield(rawInput, attacker, game);
      return;
    }

    const mult = !isFall && !alreadyScaled && game?.getDamageMultiplier ? game.getDamageMultiplier() : 1;
    const scaledDam = rawInput * mult;

    // Clean diminishing-returns armor: damage * 100 / (100 + armorLvl * 20), capped at Level 5 (50% max reduction)
    const armorLvl = Math.min(MAX_UPGRADE_LEVEL, Math.max(0, this.data.specials[9] || 0));
    const armor = 100 / (100 + armorLvl * 20);

    const prevEnergy = Math.round(this.data.energy);
    if (prevEnergy <= 0) return;
    const dmgAfterArmor = Math.max(1, Math.round(scaledDam * armor));
    const actualDmg = Math.min(prevEnergy, dmgAfterArmor);

    this.data.energy = Math.max(0, prevEnergy - actualDmg);
    const killed = this.data.energy <= 0;
    if (killed) {
      this.data.energy = 0;
    }

    game?.vfx?.spawnPopup(this.x, this.y - 2, `-${actualDmg}`, isFall ? '#f59e0b' : '#ef4444');

    if (attacker && attacker !== this) {
      const dmgPts = actualDmg * 100;
      attacker.data.score += dmgPts;
      attacker.data.total_score += dmgPts;
      if (killed) {
        attacker.data.kills += 1;
        attacker.data.score += 5000;
        attacker.data.total_score += 5000;

        // Leader Bounty: eliminating the strict #1 scoreboard leader (> 0 pts) awards +$4,000
        if (game?.isScoreLeader?.(this.tankNumber)) {
          attacker.data.score += LEADER_BOUNTY;
          attacker.data.total_score += LEADER_BOUNTY;
          game.vfx?.spawnPopup(attacker.x, attacker.y - 16, `BOUNTY +$${LEADER_BOUNTY}`, '#d97706', true);
          game.showToast?.(
            `LEADER BOUNTY! ${attacker.data.name} +$${LEADER_BOUNTY}`,
            '#d97706',
            70
          );
        }
      }
    } else {
      const selfDmg = isFall ? actualDmg / 3 : actualDmg;
      const penalty = Math.round(selfDmg * 50) + (killed ? 2000 : 0);
      if (killed) this.data.kills -= 1;
      this.data.score = Math.max(0, this.data.score - penalty);
      this.data.total_score = Math.max(0, this.data.total_score - penalty);
    }
  }

  onTurnStart() {
    this.rounds += 1;
    this.parActive = false;
    this.firstFrame = true;
    this._aiTurnFrames = 0;
    this.calcHillUp();
  }

  pasyHitCol(col) {
    if (!col || col.height <= 0) return false;
    const colTop = col.y - col.height / 2;
    const colBot = col.y + col.height / 2;
    const colLeft = col.x - 0.5;
    const colRight = col.x + 0.5;
    const pLeft = this.x + TANK_PASY_LEFT;
    const pRight = this.x + TANK_PASY_RIGHT;
    const pTop = this.y + TANK_PASY_TOP;
    const pBot = this.y + TANK_PASY_BOTTOM;
    return pRight >= colLeft && pLeft <= colRight && pBot >= colTop && pTop <= colBot;
  }

  hitTestTank(other) {
    return (
      Math.abs(this.x - other.x) < TANK_WIDTH &&
      Math.abs(this.y - other.y) < TANK_HEIGHT
    );
  }

  hitTestProjectile(px, py, halfW = 1.15, halfH = 1.15, includeShield = true) {
    if (!this.data.live && !this.dying) return false;
    if (includeShield && this.shActive) {
      return (
        Math.abs(px - this.x) <= SHIELD_RADIUS + halfW &&
        Math.abs(py - this.y) <= SHIELD_RADIUS + halfH
      );
    }
    return (
      Math.abs(px - this.x) <= TANK_HALF_W + halfW &&
      Math.abs(py - this.y) <= TANK_HALF_H + halfH
    );
  }

  hitTestExplosion(ex, ey, halfW, halfH) {
    if (!this.data.live || this.data.energy <= 0) return false;
    const hitBody =
      Math.abs(ex - this.x) <= halfW + TANK_HALF_W &&
      Math.abs(ey - this.y) <= halfH + TANK_HALF_H;
    if (hitBody) return true;
    if (this.shActive) {
      return (
        Math.abs(ex - this.x) <= halfW + SHIELD_RADIUS &&
        Math.abs(ey - this.y) <= halfH + SHIELD_RADIUS
      );
    }
    return false;
  }

  // Ground/falling physics with unified pixel-based fall damage: (dropPx - 18) * 1.5
  _stepGroundPhysics(game, isTesting) {
    const terrain = game.terrain;
    // Skip fall damage during initial round spawn settling (before Turn 1 starts)
    const allowFallDmg = !isTesting || Boolean(game.activeTank);
    // Attribute crater-induced fall damage during settling to the active shooter
    const fallAttacker = isTesting && game.activeTank && game.activeTank !== this ? game.activeTank : this;
    if (!isTesting) {
      this.naZemi = false;
      this.left = true;
      this.right = true;
    }
    let min = 500;
    let gg = false;
    this.testHill(terrain);

    for (let i = 0; i < TANK_WIDTH; i++) {
      const col = terrain.getCol(Math.round(this.x - TANK_HALF_W + i));
      if (col && this.pasyHitCol(col)) {
        if (this.parOut) {
          this.parOut = false;
        }
        if (allowFallDmg && !this.parUsedThisFall && this.fallStartY !== null) {
          const dropPx = this.y - this.fallStartY;
          if (dropPx > 18) {
            const fallDmg = Math.round((dropPx - 18) * 1.5);
            if (fallDmg > 0) {
              this.damage(fallDmg, fallAttacker, true, game);
            }
          }
        }
        this.naZemi = true;
        this.fall = 0;
        this.fallStartY = null;
        this.parUsedThisFall = false;
      }

      if (col) {
        const top = col.y - col.height / 2;
        if (top < min && this.naZemi) {
          gg = true;
          min = top;
        }
      }
      if (i + 1 >= TANK_WIDTH && this.naZemi && gg) {
        this.y = min - 2;
        gg = false;
      }
      if (isTesting && this.fall > 0.001) {
        this.test = false;
      }

      if (!this.naZemi) {
        if (this.fallStartY === null) {
          this.fallStartY = this.y;
          this.parUsedThisFall = false;
        }
        if (this.fall >= 0.2 && this.par && this.data.specials[0] > 0) {
          if (!this.parActive) {
            this.parActive = true;
            this.data.specials[0] = Math.max(0, this.data.specials[0] - 1);
            if (this.data.specials[0] <= 0) this.par = false;
          }
          this.parOut = true;
          this.parUsedThisFall = true;
        }
        this.y += this.fall;
        if (!this.parOut) {
          this.fall += 0.01;
        } else {
          this.fall = 0.2;
          this.x += terrain.vitr / 3000;
        }
      }
    }
  }

  // Step 1 frame at 25Hz
  tick(game, input) {
    // Barrel recoil animation (15 frames)
    if (this.barrelPlaying) {
      this.barrelFrame++;
      if (this.barrelFrame >= 15) {
        this.barrelFrame = 0;
        this.barrelPlaying = false;
      }
    }

    if (this.dead) return;

    // Death explosion animation timeline (Frames 4..15)
    if (this.dying) {
      this.deathFrame++;
      if (this.deathFrame === 9) {
        game.terrain.carveTankDeath(this.x, this.y, TANK_DEATH_EXPL_W, TANK_DEATH_EXPL_H);
        for (const other of game.tanks) {
          if (other.tankNumber === this.tankNumber || !other.data.live || other.data.energy <= 0) continue;
          if (other.hitTestExplosion(this.x, this.y, TANK_DEATH_EXPL_W / 2, TANK_DEATH_EXPL_H / 2)) {
            const dx = this.x - other.x;
            const dy = this.y - other.y;
            const vzd = Math.sqrt(dx * dx + dy * dy);
            let damg;
            if (!other.shActive) {
              damg = Math.round(TANK_DEATH_EXPL_W / ((vzd + 1) / 14));
            } else {
              damg = Math.round(TANK_DEATH_EXPL_W / ((vzd / 2 + 1) / 18));
            }
            other.damage(damg, this, false, game);
          }
        }
      }
      if (this.deathFrame >= 15) {
        this.dead = true;
        this.dying = false;
        if (this.playing) {
          this.playing = false;
          game.triggerTest();
        }
      }
      return;
    }

    // Check fell off bottom of screen (y > 400)
    if (this.y > STAGE_H) {
      const killer = game.activeTank && game.activeTank !== this ? game.activeTank : this;
      if (this.data.energy > 0) {
        this.damage(99999, killer, true, game);
      }
      this.data.live = false;
      this.data.energy = 0;
      this._beginDeath(game);
      return;
    }

    // Check energy depleted (energy <= 0)
    if (this.data.energy <= 0) {
      this.data.energy = 0;
      this.data.live = false;
      this._beginDeath(game);
      return;
    }

    const maxPow = getMaxPower(this.data.energy);

    // Active turn controls (for human tank)
    if (this.playing && this.type === 'tank' && input) {
      if (input.left && this.left && this.data.fuel > 0 && this.x > 10) {
        this.moveLeft(game.tanks);
      } else if (input.right && this.right && this.data.fuel > 0 && this.x < STAGE_W - 10) {
        this.moveRight(game.tanks);
      } else {
        this.moving = false;
      }

      if (input.fire) {
        game.fireCurrentTank();
        return;
      }

      this._stepGroundPhysics(game, false);

      // Power up/down (PageUp / PageDown + W/S aliases), floored at maxPow >= 60
      if (input.powerUp && this.power < maxPow) {
        this.power = Math.min(maxPow, this.power + 1);
      } else if (input.powerDown && this.power > 0) {
        this.power = Math.max(0, this.power - 1);
      }
      if (this.power > maxPow) {
        this.power = maxPow;
      }

      // Angle up/down (Up/Down arrows, step = 2 deg)
      let rotatingTurret = false;
      if (input.angleUp && this.rotace < 180) {
        this.rotace = Math.min(180, this.rotace + 2);
        rotatingTurret = true;
      }
      if (input.angleDown && this.rotace > 0) {
        this.rotace = Math.max(0, this.rotace - 2);
        rotatingTurret = true;
      }
      if (rotatingTurret) {
        game.sound.play(SOUNDS.TURRET_MOVE, { volume: 0.45, noMultiple: true });
      } else if (!game.draggingAngle) {
        game.sound.stop(SOUNDS.TURRET_MOVE);
      }
    } else if (this.playing && this.type === 'ai') {
      // Ground physics during AI turn
      this._stepGroundPhysics(game, false);
      if (this.power > maxPow) {
        this.power = maxPow;
      }
    }

    // Settling / falling check phase (testing == true)
    if (this.testing) {
      this._stepGroundPhysics(game, true);
      if (this.fall > 0.001) {
        this.test = false;
      }
      this.testHill(game.terrain);
      this.x3 = this.x2;
      this.x2 = this.x1;
      this.x1 = Math.round(this.x);
      this.y3 = this.y2;
      this.y2 = this.y1;
      this.y1 = Math.round(this.y * 10) / 10;
      if (this.y1 === this.y3 && this.x1 === this.x3) {
        this.test = true;
      }
      if (this.test) {
        this.testing = false;
      }
      this.test = true;
    }
  }

  _beginDeath(game) {
    this.dying = true;
    this.deathFrame = 4;
    this.parOut = false;
    this.fallStartY = null;
    this.parUsedThisFall = false;
    this.disableShield();
    this.testing = false;
    game.aliveCount = Math.max(0, game.aliveCount - 1);
    game.vfx?.spawnExplosion(this.x, this.y, TANK_DEATH_EXPL_W, 'death');
    game.sound.play(SOUNDS.TANK_EXPLODE, { volume: 0.9, minIntervalMs: 50 });
  }

  // Clean Paper-Cut tank renderer with soft shadow, double-ring shield, and overhead micro HP/nameplate
  render(ctx, game = null) {
    if (this.dead || !this.visible || this.dying) return;

    const baseRgb = hexIntToRgb(this.data.col ?? 0x333333);
    const bodyCol = rgbStr(baseRgb);
    const turretCol = rgbStr(tintRgb(baseRgb, 28));
    const darkCol = rgbStr(tintRgb(baseRgb, -40));
    const isActive = Boolean(game && game.activeTank === this && this.playing);

    ctx.save();
    ctx.translate(this.x, this.y);

    // 1. Parachute canopy above tank
    if (this.parOut) {
      ctx.save();
      ctx.strokeStyle = 'rgba(30, 41, 59, 0.55)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(-7, -14);
      ctx.lineTo(-2, -3);
      ctx.moveTo(7, -14);
      ctx.lineTo(2, -3);
      ctx.moveTo(0, -15);
      ctx.lineTo(0, -3);
      ctx.stroke();

      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(0, -14, 8.5, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.arc(0, -14, 8.5, Math.PI + 0.85, -0.85);
      ctx.lineTo(0, -14);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 2. Soft elliptical contact shadow
    ctx.fillStyle = 'rgba(15, 23, 42, 0.18)';
    ctx.beginPath();
    ctx.ellipse(0, 3.8, 9.2, 1.8, 0, 0, Math.PI * 2);
    ctx.fill();

    // 3. Articulated barrel with crisp recoil kickback
    const recoil = this.barrelPlaying ? Math.sin((this.barrelFrame / 15) * Math.PI) * 2.2 : 0;
    const rad = (this.rotace * Math.PI) / 180;
    ctx.save();
    ctx.translate(0, -1.6);
    ctx.rotate(rad);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2.0;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-(10.2 - recoil), 0);
    ctx.stroke();
    ctx.restore();

    // 4. Sleek Paper-Cut faceted tank hull & bright turret cap
    ctx.fillStyle = bodyCol;
    ctx.beginPath();
    ctx.moveTo(-8.2, 1.0);
    ctx.lineTo(-6.2, -3.2);
    ctx.lineTo(6.2, -3.2);
    ctx.lineTo(8.2, 1.0);
    ctx.closePath();
    ctx.fill();

    // Subtle shaded bottom bevel
    ctx.fillStyle = darkCol;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(-7.8, 0.0, 15.6, 1.1);
    ctx.globalAlpha = 1;

    // Turret dome
    ctx.fillStyle = turretCol;
    ctx.beginPath();
    ctx.moveTo(-3.8, -3.1);
    ctx.lineTo(-2.5, -5.6);
    ctx.lineTo(2.5, -5.6);
    ctx.lineTo(3.8, -3.1);
    ctx.closePath();
    ctx.fill();

    // Rounded dark-slate treads
    ctx.fillStyle = '#334155';
    ctx.beginPath();
    ctx.roundRect(-7.6, 1.0, 15.2, 2.5, 1.25);
    ctx.fill();

    // 5. Double-ring Paper-Cut Shield dome
    if (this.shActive) {
      const sc = SHIELD_COLORS[this.shieldTier] || SHIELD_COLORS[1];
      const pct = Math.max(0.15, Math.min(1, this.shieldEnergy / (this.shieldMax || 1)));
      ctx.save();
      ctx.globalAlpha = 0.35 + pct * 0.65;
      ctx.fillStyle = sc.fill;
      ctx.strokeStyle = sc.stroke;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(0, -1, SHIELD_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.52)';
      ctx.lineWidth = 0.85;
      ctx.setLineDash([3.5, 3.5]);
      ctx.beginPath();
      ctx.arc(0, -1, SHIELD_RADIUS - 2.8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 6. Overhead micro HP/Shield bar & player nameplate
    const barY = this.shActive ? -(SHIELD_RADIUS + 8) : -14.5;
    const barW = 24;
    const barH = 2.8;
    const hpPct = Math.max(0, Math.min(1, this.data.energy / (this.data.max_energy || 100)));
    const hpCol = hpPct > 0.5 ? '#22c55e' : hpPct > 0.25 ? '#f59e0b' : '#ef4444';

    // Shield mini-bar above HP bar when active
    if (this.shActive && this.shieldMax > 0) {
      const shPct = Math.max(0, Math.min(1, this.shieldEnergy / this.shieldMax));
      ctx.fillStyle = 'rgba(15, 23, 42, 0.38)';
      ctx.beginPath();
      ctx.roundRect(-barW / 2, barY - 3.6, barW, 2.2, 1.1);
      ctx.fill();
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.roundRect(-barW / 2, barY - 3.6, barW * shPct, 2.2, 1.1);
      ctx.fill();
    }

    // HP track & fill
    ctx.fillStyle = 'rgba(15, 23, 42, 0.42)';
    ctx.beginPath();
    ctx.roundRect(-barW / 2, barY, barW, barH, 1.4);
    ctx.fill();
    if (hpPct > 0) {
      ctx.fillStyle = hpCol;
      ctx.beginPath();
      ctx.roundRect(-barW / 2, barY, Math.max(2, barW * hpPct), barH, 1.4);
      ctx.fill();
    }

    // Player nameplate above bar
    const nameY = this.shActive ? barY - 7.5 : barY - 4.2;
    ctx.font = `${isActive ? '800' : '600'} 7px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
    const label = isActive ? `▾ ${this.data.name}` : this.data.name;
    ctx.strokeText(label, 0, nameY);
    ctx.fillStyle = isActive ? '#0f172a' : '#334155';
    ctx.fillText(label, 0, nameY);

    ctx.restore();
  }
}
