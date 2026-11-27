// 5-difficulty AI artillery controller with physics ballistic solver,
// smart weapon/special usage, and full between-round shop economy.

import { STAGE_W, STAGE_H, WEAPONS, SPECIALS, SHIELD_TIERS, SOUNDS } from './constants.js';

// Difficulty profiles: scatter shrinks on follow-up shots against the same target
const DIFFICULTY_PROFILE = {
  Very_easy: {
    rotScatter: 10.5,
    powScatter: 11.5,
    followUpDecay: 0.85,
    airStrikeJitter: 45,
    useRepairThresh: 0.35,
    maxRepairsPerTurn: 1,
    shieldChance: 0.15,
    shieldHpThresh: 0.5,
    useSpecialWeaponsChance: 0.35,
    useTeleport: false,
    useRollers: false,
    smartTarget: false,
    selfSafeCheck: false,
    shopSpendRatio: 0.45,
    shopMaxTier: 1,
  },
  easy: {
    rotScatter: 6.0,
    powScatter: 7.0,
    followUpDecay: 0.75,
    airStrikeJitter: 28,
    useRepairThresh: 0.45,
    maxRepairsPerTurn: 1,
    shieldChance: 0.35,
    shieldHpThresh: 0.65,
    useSpecialWeaponsChance: 0.55,
    useTeleport: false,
    useRollers: true,
    smartTarget: false,
    selfSafeCheck: true,
    shopSpendRatio: 0.65,
    shopMaxTier: 2,
  },
  normal: {
    rotScatter: 2.6,
    powScatter: 3.2,
    followUpDecay: 0.62,
    airStrikeJitter: 14,
    useRepairThresh: 0.6,
    maxRepairsPerTurn: 2,
    shieldChance: 0.65,
    shieldHpThresh: 0.8,
    useSpecialWeaponsChance: 0.78,
    useTeleport: false,
    useRollers: true,
    smartTarget: true,
    selfSafeCheck: true,
    shopSpendRatio: 0.8,
    shopMaxTier: 3,
  },
  hard: {
    rotScatter: 0.85,
    powScatter: 1.0,
    followUpDecay: 0.4,
    airStrikeJitter: 5,
    useRepairThresh: 0.72,
    maxRepairsPerTurn: 3,
    shieldChance: 0.85,
    shieldHpThresh: 0.95,
    useSpecialWeaponsChance: 0.92,
    useTeleport: true,
    useRollers: true,
    smartTarget: true,
    selfSafeCheck: true,
    shopSpendRatio: 0.95,
    shopMaxTier: 4,
  },
  very_hard: {
    rotScatter: 0.15,
    powScatter: 0.2,
    followUpDecay: 0.0,
    airStrikeJitter: 0,
    useRepairThresh: 0.78,
    maxRepairsPerTurn: 4,
    shieldChance: 0.95,
    shieldHpThresh: 1.01,
    useSpecialWeaponsChance: 1.0,
    useTeleport: true,
    useRollers: true,
    smartTarget: true,
    selfSafeCheck: true,
    shopSpendRatio: 1.0,
    shopMaxTier: 5,
  },
};

function getProfile(dif) {
  return DIFFICULTY_PROFILE[dif] || DIFFICULTY_PROFILE.normal;
}

// ==================== EXACT BALLISTIC TRAJECTORY SIMULATOR ====================

function simulateTrajectory(tank, target, game, rotace, power, opts = {}) {
  const terrain = game.terrain;
  const tanks = game.tanks;
  const vitr = terrain.vitr;
  const x0 = tank.x;
  const y0 = tank.y - 1;
  const parentRot = rotace - 90;
  const uhel = -parentRot + 90;
  let vox = Math.cos((Math.PI / 180) * uhel) * power;
  const voy = Math.sin(0.017 * uhel) * power;
  const gHalf = 9.81 / 2;
  const isRoller = Boolean(opts.isRoller);
  const uphill = Boolean(opts.uphill);

  let selfProtect = true;
  let t = 0;

  for (let step = 0; step < 260; step++) {
    const x = x0 + vox * t;
    const y = y0 - voy * t + gHalf * t * t;

    if (x < 0 || x > STAGE_W || y > STAGE_H) {
      return {
        hit: false,
        oob: true,
        direct: false,
        hitTarget: false,
        selfHit: false,
        x,
        y,
        t,
        dist: Math.hypot(x - target.x, y - target.y),
        selfDist: Math.hypot(x - tank.x, y - tank.y),
      };
    }

    // Tank / shield collision check
    for (let i = 0; i < tanks.length; i++) {
      const other = tanks[i];
      if (!other.data.live) continue;
      if (other.tankNumber !== tank.tankNumber) {
        if (other.hitTestProjectile(x, y, 1.5, 1.5, true)) {
          const isTarget = other.tankNumber === target.tankNumber;
          return {
            hit: true,
            oob: false,
            direct: isTarget,
            hitTarget: isTarget,
            hitEnemy: true,
            selfHit: false,
            x,
            y,
            t,
            dist: isTarget ? 0 : Math.hypot(x - target.x, y - target.y),
            selfDist: Math.hypot(x - tank.x, y - tank.y),
          };
        }
      } else if (!selfProtect && other.hitTestProjectile(x, y, 1.5, 1.5, true)) {
        return {
          hit: true,
          oob: false,
          direct: false,
          hitTarget: false,
          selfHit: true,
          x,
          y,
          t,
          dist: Math.hypot(x - target.x, y - target.y),
          selfDist: 0,
        };
      }
    }

    if (selfProtect && !tank.hitTestProjectile(x, y, 1.5, 1.5, true)) {
      selfProtect = false;
    }

    // Terrain impact
    if (x >= 0 && x < STAGE_W && terrain.hitPoint(x, y, 1.5)) {
      if (isRoller) {
        return simulateRollPhase(tank, target, game, x, uphill, t);
      }
      const dist = Math.hypot(x - target.x, y - target.y);
      const selfDist = Math.hypot(x - tank.x, y - tank.y);
      return {
        hit: true,
        oob: false,
        direct: dist <= 9,
        hitTarget: dist <= 14,
        hitEnemy: dist <= 14,
        selfHit: selfDist <= 10,
        x,
        y,
        t,
        dist,
        selfDist,
      };
    }

    vox += vitr / 600;
    t += 0.1;
  }

  return {
    hit: false,
    oob: true,
    direct: false,
    hitTarget: false,
    selfHit: false,
    x: x0,
    y: y0,
    t,
    dist: 999,
    selfDist: 999,
  };
}

function simulateRollPhase(tank, target, game, startX, uphill, impactT) {
  const terrain = game.terrain;
  const tanks = game.tanks;
  let rx = startX;
  let smer = null;
  let rollStart = true;

  for (let step = 0; step < 300; step++) {
    const ix = Math.round(rx);
    if (ix <= 1 || ix >= STAGE_W - 2) {
      return {
        hit: false, oob: true, direct: false, hitTarget: false, selfHit: false,
        x: rx, y: terrain.topY(Math.max(0, Math.min(STAGE_W - 1, ix))), t: impactT,
        dist: 999, selfDist: 999,
      };
    }
    const cury = terrain.topY(ix);

    for (let i = 0; i < tanks.length; i++) {
      const other = tanks[i];
      if (!other.data.live) continue;
      if (other.hitTestProjectile(rx, cury, 1.5, 1.5, true)) {
        const isSelf = other.tankNumber === tank.tankNumber;
        const isTarget = other.tankNumber === target.tankNumber;
        return {
          hit: true, oob: false, direct: isTarget, hitTarget: isTarget, hitEnemy: !isSelf, selfHit: isSelf,
          x: rx, y: cury, t: impactT,
          dist: isTarget ? 0 : Math.hypot(rx - target.x, cury - target.y),
          selfDist: isSelf ? 0 : Math.hypot(rx - tank.x, cury - tank.y),
        };
      }
    }

    const curly = terrain.topY(ix - 1);
    const curpy = terrain.topY(ix + 1);
    if (rollStart) {
      if (!uphill) {
        if (curly < cury && curpy < cury) break;
        if (!(curly < cury)) smer = 'left';
        else if (!(curpy < cury)) smer = 'right';
      } else {
        if (cury < curly && cury < curpy) break;
        if (!(curly < cury)) smer = 'right';
        else if (!(curpy < cury)) smer = 'left';
      }
      rollStart = false;
    }

    const lastx = ix;
    if (smer === 'left') {
      const ny = terrain.topY(ix - 1);
      const ok = uphill ? !(cury < ny) : !(ny < cury);
      if (ok) rx -= 1;
      else break;
    } else if (smer === 'right') {
      const ny = terrain.topY(ix + 1);
      const ok = uphill ? !(cury < ny) : !(ny < cury);
      if (ok) rx += 1;
      else break;
    }
    if (lastx === Math.round(rx)) {
      smer = tank.x < rx ? 'right' : 'left';
    }
  }

  const ry = terrain.topY(Math.max(0, Math.min(STAGE_W - 1, Math.round(rx))));
  const dist = Math.hypot(rx - target.x, ry - target.y);
  const selfDist = Math.hypot(rx - tank.x, ry - tank.y);
  return {
    hit: true, oob: false, direct: dist <= 10, hitTarget: dist <= 16, hitEnemy: dist <= 16, selfHit: selfDist <= 14,
    x: rx, y: ry, t: impactT, dist, selfDist,
  };
}

// Find optimal (rotace, power) using coarse physics sweep + integer local refinement
export function solveBallisticShot(tank, target, game, opts = {}) {
  const maxPow = Math.max(1, Math.min(100, Math.floor(tank.data.energy)));
  const minSafeSelf = opts.minSafeSelf ?? 18;
  const requireSplitTime = Boolean(opts.requireSplitTime);
  const targetRight = target.x >= tank.x;
  const vitr = game.terrain.vitr;

  // Build candidate angle range (allow firing slightly against steep winds)
  const rotMin = targetRight ? (vitr > 20 ? 72 : 91) : 2;
  const rotMax = targetRight ? 178 : (vitr < -20 ? 108 : 89);

  const scoreCandidate = (sim, rot) => {
    if (sim.selfHit) return 10000 + sim.dist;
    let s = sim.dist;
    if (sim.selfDist < minSafeSelf) {
      s += (minSafeSelf - sim.selfDist) * 25 + 400;
    }
    if (sim.oob) s += 300;
    if (requireSplitTime && sim.t < 3.05) {
      s += 250;
    }
    if (sim.direct && sim.hitTarget) {
      // Slight tie-breaker favoring cleaner arcs that stay safely away from self
      s = -100 + Math.abs(rot - (targetRight ? 132 : 48)) * 0.02 - Math.min(40, sim.selfDist) * 0.05;
    }
    return s;
  };

  // Coarse grid search (handles low-energy tanks with maxPow < 8 cleanly)
  const powStart = maxPow < 8 ? 1 : 8;
  const powStep = maxPow < 8 ? 1 : 5;
  const topSeeds = [];
  for (let rot = rotMin; rot <= rotMax; rot += 3) {
    for (let pow = powStart; pow <= maxPow; pow += powStep) {
      const sim = simulateTrajectory(tank, target, game, rot, pow, opts);
      const sc = scoreCandidate(sim, rot);
      if (topSeeds.length < 6 || sc < topSeeds[topSeeds.length - 1].sc) {
        topSeeds.push({ rot, pow, sim, sc });
        topSeeds.sort((a, b) => a.sc - b.sc);
        if (topSeeds.length > 6) topSeeds.pop();
      }
    }
  }

  // Fine integer refinement around best coarse regions
  let best = topSeeds[0];
  if (!best) {
    const fbRot = targetRight ? 135 : 45;
    const fbPow = Math.min(maxPow, 50);
    const fbSim = simulateTrajectory(tank, target, game, fbRot, fbPow, opts);
    best = { rot: fbRot, pow: fbPow, sim: fbSim, sc: scoreCandidate(fbSim, fbRot) };
  }

  const visited = new Set();
  for (let si = 0; si < topSeeds.length; si++) {
    const seed = topSeeds[si];
    const r0 = Math.max(1, seed.rot - 3);
    const r1 = Math.min(179, seed.rot + 3);
    const p0 = Math.max(1, seed.pow - 6);
    const p1 = Math.min(maxPow, seed.pow + 6);
    for (let rot = r0; rot <= r1; rot++) {
      for (let pow = p0; pow <= p1; pow++) {
        const key = rot * 200 + pow;
        if (visited.has(key)) continue;
        visited.add(key);
        const sim = simulateTrajectory(tank, target, game, rot, pow, opts);
        const sc = scoreCandidate(sim, rot);
        if (sc < best.sc) {
          best = { rot, pow, sim, sc };
        }
      }
    }
  }

  // Extra half-step micro-refinement if not yet a direct bullseye
  if (!best.sim.direct && best.sim.dist < 40) {
    const baseR = best.rot;
    const baseP = best.pow;
    for (let dr = -1; dr <= 1; dr += 0.5) {
      for (let dp = -1; dp <= 1; dp += 0.5) {
        const rot = Math.max(1, Math.min(179, baseR + dr));
        const pow = Math.max(1, Math.min(maxPow, baseP + dp));
        const sim = simulateTrajectory(tank, target, game, rot, pow, opts);
        const sc = scoreCandidate(sim, rot);
        if (sc < best.sc) {
          best = { rot, pow, sim, sc };
        }
      }
    }
  }

  return best;
}

// ==================== TARGETING, SPECIALS & WEAPON SELECTION ====================

export function aiSelectTarget(tank, game) {
  const prof = getProfile(tank.dif);
  const candidates = game.tanks.filter(
    (other) => other.tankNumber !== tank.tankNumber && other.data.live
  );
  if (!candidates.length) {
    tank.target = null;
    return null;
  }

  if (!prof.smartTarget) {
    // Nearest living enemy
    let best = candidates[0];
    let bestD = Math.abs(tank.x - best.x);
    for (const c of candidates) {
      const d = Math.abs(tank.x - c.x);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    tank.target = best;
    return best;
  }

  // Smart threat & finish-off scoring for Normal / Hard / Very Hard
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const c of candidates) {
    const dist = Math.abs(tank.x - c.x);
    let score = 200 - dist * 0.25;
    // Prioritize finishing low-HP enemies (kill bounty + eliminate threat)
    if (!c.shActive && c.data.energy <= 45) score += 90;
    else if (!c.shActive && c.data.energy <= 75) score += 35;
    // Slight focus on score leader
    score += Math.min(60, (c.data.total_score || 0) / 800);
    // Slight preference to finish current target if already dialed in
    if (tank.target && tank.target.tankNumber === c.tankNumber) score += 20;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  tank.target = best;
  return best;
}

function findBestTeleportSpot(tank, game) {
  const terrain = game.terrain;
  let bestX = tank.x;
  let bestScore = -Infinity;
  for (let x = 40; x <= STAGE_W - 40; x += 15) {
    const topY = terrain.topY(x);
    if (topY > STAGE_H - 35 || topY < 75) continue;
    // Prefer higher ridges with open sky and safe spacing from enemies
    let minEnemyDist = 999;
    for (const other of game.tanks) {
      if (other.tankNumber === tank.tankNumber || !other.data.live) continue;
      minEnemyDist = Math.min(minEnemyDist, Math.abs(x - other.x));
    }
    if (minEnemyDist < 55) continue;
    const leftY = terrain.topY(x - 10);
    const rightY = terrain.topY(x + 10);
    // Avoid deep pits (neighbors much higher than x)
    const pitPenalty = Math.max(0, (topY - leftY)) + Math.max(0, (topY - rightY));
    const sc = (STAGE_H - topY) * 1.1 - pitPenalty * 2.5 + Math.min(180, minEnemyDist) * 0.4;
    if (sc > bestScore) {
      bestScore = sc;
      bestX = x;
    }
  }
  return { x: bestX, y: Math.max(70, terrain.topY(bestX) - 6) };
}

function aiUseDefensiveSpecials(tank, game, prof) {
  const pd = tank.data;

  // 1. Ensure parachute is enabled if owned
  if (pd.specials[0] > 0 && !tank.par) {
    game.toggleParachute(false, true);
  }

  // 2. Use Repair Kits when damaged
  if (pd.specials[1] > 0 && pd.energy < pd.max_energy * prof.useRepairThresh) {
    let used = 0;
    while (
      used < prof.maxRepairsPerTurn &&
      pd.specials[1] > 0 &&
      pd.energy < pd.max_energy - 5 &&
      pd.energy < pd.max_energy * Math.min(0.92, prof.useRepairThresh + 0.2)
    ) {
      game.useRepair(false, true);
      used++;
    }
  }

  // 3. Activate an owned Shield if unshielded and threatened
  if (!tank.shActive && pd.energy <= pd.max_energy * prof.shieldHpThresh) {
    if ((game.aiRng || game.rng).nextFloat() < prof.shieldChance) {
      // Higher difficulties prefer stronger shields; lower difficulties start with weaker shields
      const tiers = prof.shopMaxTier >= 4 ? [4, 3, 2, 1] : prof.shopMaxTier >= 3 ? [3, 2, 1, 4] : [1, 2, 3, 4];
      for (const tier of tiers) {
        const spec = SHIELD_TIERS[tier];
        if (spec && pd.specials[spec.specialIdx] > 0) {
          game.activateShield(tier, false, true);
          break;
        }
      }
    }
  }
}

function aiPickWeaponAndPlan(tank, target, game, prof) {
  const guns = tank.data.guns;
  const rng = game.aiRng || game.rng;

  // Solve primary direct/arc ballistic shot first
  const baseSol = solveBallisticShot(tank, target, game, {
    minSafeSelf: prof.selfSafeCheck ? 20 : 0,
  });

  const blocked = !baseSol.sim.hitTarget && baseSol.sim.dist > 32;
  const distToTarget = Math.hypot(tank.x - target.x, tank.y - target.y);

  // Check if trapped in a crater/pit -> Teleport to high ground (Hard / Very Hard)
  if (prof.useTeleport && blocked && tank.data.specials[7] > 0 && baseSol.sim.selfDist < 40) {
    const spot = findBestTeleportSpot(tank, game);
    if (Math.abs(spot.x - tank.x) > 45) {
      return { action: 'teleport', spot };
    }
  }

  // Decide whether to use special weapons this turn
  const wantSpecial = rng.nextFloat() < prof.useSpecialWeaponsChance;

  // Air Strike (13): devastating against shielded, dug-in, or blocked targets
  if (wantSpecial && guns[13] > 0 && (blocked || target.shActive || target.data.energy >= 65)) {
    const jitter = prof.airStrikeJitter > 0 ? (rng.nextFloat() * 2 - 1) * prof.airStrikeJitter : 0;
    return {
      action: 'astrike',
      gun: 13,
      targetX: Math.max(25, Math.min(STAGE_W - 25, target.x + jitter)),
      uhel: target.x >= tank.x ? 0 : 180,
    };
  }

  // If target is nearly dead (<= 15 HP, no shield) and we have a clean shot, don't waste expensive nukes
  if (!target.shActive && target.data.energy <= 15 && baseSol.sim.hitTarget) {
    const gun = guns[1] > 0 && distToTarget > 20 ? 1 : 0;
    return { action: 'fire', gun, sol: baseSol };
  }

  if (wantSpecial) {
    // Check Rollers (V1 downhill: 9,8,7; V2 uphill: 12,11,10) when slope favors them or direct is blocked
    if (prof.useRollers) {
      const rollerOrder = [
        { id: 9, uphill: false, safe: 55 },
        { id: 12, uphill: true, safe: 55 },
        { id: 8, uphill: false, safe: 38 },
        { id: 11, uphill: true, safe: 38 },
        { id: 7, uphill: false, safe: 22 },
        { id: 10, uphill: true, safe: 22 },
      ];
      for (const r of rollerOrder) {
        if (guns[r.id] <= 0) continue;
        if (prof.selfSafeCheck && distToTarget < r.safe) continue;
        // Prefer trying rollers when target is blocked or ~30% of turns for variety
        if (!blocked && rng.nextFloat() > 0.35) continue;
        const rSol = solveBallisticShot(tank, target, game, {
          isRoller: true,
          uphill: r.uphill,
          minSafeSelf: prof.selfSafeCheck ? r.safe : 0,
        });
        if (rSol.sim.hitTarget && (!prof.selfSafeCheck || rSol.sim.selfDist >= r.safe)) {
          return { action: 'fire', gun: r.id, sol: rSol };
        }
      }
    }

    // Check Hot Shower (6) & Shower (5) when long-arc flight time >= 3.05s triggers clean mid-air split
    const showerIds = target.shActive || target.data.energy >= 65 ? [6, 5] : [5, 6];
    for (const sid of showerIds) {
      if (guns[sid] <= 0) continue;
      if (prof.selfSafeCheck && distToTarget < 65) continue;
      const shSol = solveBallisticShot(tank, target, game, {
        minSafeSelf: prof.selfSafeCheck ? 42 : 0,
        requireSplitTime: true,
      });
      if (shSol.sim.t >= 3.05 && shSol.sim.dist <= 28) {
        return { action: 'fire', gun: sid, sol: shSol };
      }
    }

    // Heavy & mid-tier direct explosives ordered by tactical power & self-safety
    const blastOrder = [
      { id: 3, safe: 88, preferHeavy: true },  // Atom bomb
      { id: 2, safe: 52, preferHeavy: false }, // Small atom bomb
      { id: 4, safe: 42, preferHeavy: false }, // Volcano bomb
      { id: 1, safe: 22, preferHeavy: false }, // Missile
    ];

    // Check if multiple enemies are clustered near target -> boost heavy bomb preference
    const nearbyEnemies = game.tanks.filter(
      (o) => o.data.live && o.tankNumber !== tank.tankNumber && Math.abs(o.x - target.x) < 75
    ).length;

    for (const b of blastOrder) {
      if (guns[b.id] <= 0) continue;
      if (prof.selfSafeCheck && baseSol.sim.selfDist < b.safe) continue;
      if (b.preferHeavy && !target.shActive && target.data.energy < 45 && nearbyEnemies < 2) {
        continue; // Save Atom Bomb for healthy / shielded / clustered enemies
      }
      // Verify exact trajectory respects this bomb's larger self-safe radius
      const sol =
        prof.selfSafeCheck && baseSol.sim.selfDist < b.safe
          ? solveBallisticShot(tank, target, game, { minSafeSelf: b.safe })
          : baseSol;
      if (!prof.selfSafeCheck || sol.sim.selfDist >= b.safe) {
        return { action: 'fire', gun: b.id, sol };
      }
    }
  }

  // Fallback to Missile (if safe) or Small Missile (infinite)
  if (guns[1] > 0 && (!prof.selfSafeCheck || baseSol.sim.selfDist >= 22)) {
    return { action: 'fire', gun: 1, sol: baseSol };
  }
  return { action: 'fire', gun: 0, sol: baseSol };
}

// ==================== BETWEEN-ROUND AI SHOPPING (SAME RIGHTS & PRICES AS HUMANS) ====================

export function aiBuyInShop(slot, game) {
  const pd = game.playerData[slot - 1];
  if (!pd || pd.type !== 'ai') return;
  const prof = getProfile(pd.dif);
  const rng = game.aiRng || game.rng;

  const startingCash = pd.score;
  const minReserve = Math.round(startingCash * (1 - prof.shopSpendRatio));

  const tryBuy = (kind, index) => {
    const item = kind === 'weapon' ? WEAPONS[index] : SPECIALS[index];
    if (!item || item.price <= 0) return false;
    if (pd.score - item.price < minReserve && pd.score >= minReserve) {
      // Allow spending reserve on essential defense or first good weapon
      if (pd.score < item.price) return false;
    }
    return game.applyShopPurchase(slot, kind, index, false, true);
  };

  let purchases = 0;
  const maxPurchases = 10;

  // 1. Essentials: Parachutes, Repair kits, Fuel
  if (pd.specials[0] < 2 && pd.score >= SPECIALS[0].price && purchases < maxPurchases) {
    if (tryBuy('special', 0)) purchases++;
  }
  if (pd.specials[1] < (prof.shopMaxTier >= 4 ? 4 : 2) && pd.score >= SPECIALS[1].price && purchases < maxPurchases) {
    if (tryBuy('special', 1)) purchases++;
  }
  if (pd.specials[2] < 100 && pd.score >= SPECIALS[2].price && purchases < maxPurchases) {
    if (tryBuy('special', 2)) purchases++;
  }

  // 2. Shields (if low on total shields)
  const totalShields = pd.specials[3] + pd.specials[4] + pd.specials[5] + pd.specials[6];
  if (totalShields < 2 && purchases < maxPurchases) {
    const shieldPref =
      prof.shopMaxTier >= 5 ? [6, 5, 4, 3] :
      prof.shopMaxTier >= 4 ? [5, 4, 6, 3] :
      prof.shopMaxTier >= 3 ? [4, 3, 5] : [3];
    for (const sIdx of shieldPref) {
      if (pd.score >= SPECIALS[sIdx].price) {
        if (tryBuy('special', sIdx)) {
          purchases++;
          break;
        }
      }
    }
  }

  // 3. Permanent Tank Upgrades (Energy, Armor, Hill Move, Engine) on Normal+
  if (prof.shopMaxTier >= 3 && purchases < maxPurchases) {
    // Upgrade Armor (9) up to level 5
    if (pd.specials[9] < 5 && pd.score >= SPECIALS[9].price && rng.nextFloat() < 0.65) {
      if (tryBuy('special', 9)) purchases++;
    }
    // Upgrade Energy (8) up to level 5
    if (pd.specials[8] < 5 && pd.score >= SPECIALS[8].price && rng.nextFloat() < 0.65) {
      if (tryBuy('special', 8)) purchases++;
    }
    // Teleport (7) on Hard / Very Hard if out
    if (prof.useTeleport && pd.specials[7] < 1 && pd.score >= SPECIALS[7].price + 5000) {
      if (tryBuy('special', 7)) purchases++;
    }
    // Hill move (11) / Engine (10) occasionally
    if (pd.specials[11] < 2 && pd.score >= SPECIALS[11].price && rng.nextFloat() < 0.3) {
      if (tryBuy('special', 11)) purchases++;
    }
  }

  // 4. Buy Weapons with remaining budget (weighted by difficulty tier)
  const weaponPools = {
    1: [1, 7, 4],                                      // Very easy
    2: [1, 4, 7, 8, 2],                                // Easy
    3: [2, 4, 5, 8, 11, 1],                            // Normal
    4: [3, 2, 5, 13, 4, 9, 12, 8, 1],                  // Hard
    5: [3, 6, 13, 2, 5, 9, 12, 4, 1],                  // Very hard
  };
  const pool = weaponPools[prof.shopMaxTier] || weaponPools[3];

  let safety = 0;
  while (purchases < maxPurchases && pd.score >= 2000 && safety++ < 25) {
    if (pd.score <= minReserve) break;
    // Filter affordable weapons (avoid hoarding > 6 of an ultra-expensive nuke)
    const affordable = pool.filter((wid) => {
      const w = WEAPONS[wid];
      if (!w || w.price <= 0 || pd.score < w.price) return false;
      if (w.price >= 13000 && pd.guns[wid] >= 4) return false;
      if (wid === 4 && pd.guns[4] >= 12) return false;
      return true;
    });
    if (!affordable.length) break;

    // Higher difficulties bias toward the top of their pool (strongest bombs)
    const pickIdx =
      prof.shopMaxTier >= 4 && rng.nextFloat() < 0.65
        ? rng.random(Math.min(3, affordable.length))
        : rng.random(affordable.length);
    const wid = affordable[pickIdx];
    if (tryBuy('weapon', wid)) {
      purchases++;
    } else {
      break;
    }
  }
}

// ==================== SMOOTH AIM ANIMATION & MAIN AI TICK ====================

export function aiPrepareShot(tank, game) {
  let prep = true;
  const targetRot = Math.max(0, Math.min(180, Math.round(tank.pRotace * 2) / 2));
  const maxPow = Math.max(0, Math.min(100, tank.data.energy));
  const targetPow = Math.max(0, Math.min(maxPow, Math.round(tank.pPower * 2) / 2));

  const diffRot = Math.abs(tank.rotace - targetRot);
  if (diffRot > 0.25) {
    const sp = diffRot < 2 ? diffRot : diffRot < 10 ? 1.5 : Math.floor(diffRot / 6);
    if (targetRot < tank.rotace) {
      tank.rotace = Math.max(targetRot, tank.rotace - sp);
    } else {
      tank.rotace = Math.min(targetRot, tank.rotace + sp);
    }
    prep = false;
    game.sound.play(SOUNDS.TURRET_MOVE, { volume: 0.35, noMultiple: true });
  } else {
    tank.rotace = targetRot;
    game.sound.stop(SOUNDS.TURRET_MOVE);
  }

  const diffPow = Math.abs(tank.power - targetPow);
  if (diffPow > 0.25) {
    const spPow = diffPow < 2 ? diffPow : diffPow < 10 ? 1.5 : Math.floor(diffPow / 6);
    if (targetPow < tank.power) {
      tank.power = Math.max(targetPow, tank.power - spPow);
    } else {
      tank.power = Math.min(targetPow, tank.power + spPow);
    }
    prep = false;
  } else {
    tank.power = targetPow;
  }

  if (tank.pMove && Math.round(tank.pX) !== Math.round(tank.x) && tank.data.fuel > 0) {
    const prevX = tank.x;
    const moved = Math.round(tank.pX) < Math.round(tank.x)
      ? tank.moveLeft(game.tanks)
      : tank.moveRight(game.tanks);
    if (!moved || Math.abs(tank.x - prevX) < 0.05) {
      tank.pMove = false;
    } else {
      prep = false;
    }
  }

  return prep;
}

export function tickAI(tank, game) {
  if (!tank.playing || tank.type !== 'ai' || !tank.data.live || tank.data.energy <= 0) return;

  if (tank.firstFrame) {
    tank._aiTurnFrames = 0;
    const prof = getProfile(tank.dif);
    const prevTargetNum = tank.target?.tankNumber ?? 0;

    // 1. Defensive specials (Parachute, Repair Kits, Shields)
    aiUseDefensiveSpecials(tank, game, prof);

    // 2. Select best target
    const target = aiSelectTarget(tank, game);
    if (!target) return;

    if (target.tankNumber !== prevTargetNum) {
      tank.aiConsecShots = 0;
    } else {
      tank.aiConsecShots = (tank.aiConsecShots || 0) + 1;
    }

    // 3. Pick weapon & compute ballistic plan
    const plan = aiPickWeaponAndPlan(tank, target, game, prof);

    if (plan.action === 'teleport') {
      game.beginTeleport(false, true);
      if (game.teleport) {
        tank.firstFrame = true;
        game.teleport.cursorX = plan.spot.x;
        game.teleport.cursorY = plan.spot.y;
        game._aiPendingTeleport = { x: plan.spot.x, y: plan.spot.y, delay: 10 };
        return;
      }
    }

    if (plan.action === 'astrike') {
      game.selectWeapon(plan.gun, false, true);
      tank.lastWind = game.terrain.vitr;
      game.fireCurrentTank();
      if (game.airStrike) {
        tank.firstFrame = true;
        game.airStrike.uhel = plan.uhel;
        game.airStrike.cursorX = plan.targetX;
        game.airStrike.cursorY = 110;
        game._aiPendingAirStrike = { x: plan.targetX, uhel: plan.uhel, delay: 14 };
        return;
      }
    }

    // Standard / Roller / Cluster ballistic fire plan
    const sol = plan.sol || solveBallisticShot(tank, target, game, {
      minSafeSelf: prof.selfSafeCheck ? 20 : 0,
    });
    const gunId = typeof plan.gun === 'number' ? plan.gun : 0;
    game.selectWeapon(gunId, false, true);

    // Apply difficulty scatter (tightens on consecutive turns against same target)
    const decay = Math.pow(prof.followUpDecay, tank.aiConsecShots || 0);
    const aiRng = game.aiRng || game.rng;
    const rotErr = (aiRng.nextFloat() * 2 - 1) * prof.rotScatter * decay;
    const powErr = (aiRng.nextFloat() * 2 - 1) * prof.powScatter * decay;
    const maxPow = Math.max(0, Math.min(100, tank.data.energy));
    const minPow = Math.min(2, maxPow);

    tank.pRotace = Math.max(1, Math.min(179, sol.rot + rotErr));
    tank.pPower = Math.max(minPow, Math.min(maxPow, sol.pow + powErr));
    tank.pMove = false;
    tank.firstFrame = false;
  }

  tank._aiTurnFrames = (tank._aiTurnFrames || 0) + 1;
  if (aiPrepareShot(tank, game) || tank._aiTurnFrames >= 75) {
    tank.power = Math.max(0, Math.min(100, tank.data.energy, tank.power));
    game.sound.stop(SOUNDS.TURRET_MOVE);
    tank.lastWind = game.terrain.vitr;
    tank.firstFrame = true;
    tank._aiTurnFrames = 0;
    game.fireCurrentTank();
  }
}
