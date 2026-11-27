// 5-difficulty AI artillery controller

import { AI_PARAMS, SOUNDS } from './constants.js';

function pm(val) {
  return val > 0 ? 1 : -1;
}

export function aiSelectTarget(tank, game) {
  let bestDist = 1000;
  let best = null;
  for (const other of game.tanks) {
    if (other.tankNumber === tank.tankNumber || !other.data.live) continue;
    const d = Math.abs(tank.x - other.x);
    if (d < bestDist) {
      bestDist = d;
      best = other;
    }
  }
  tank.target = best;
  return best;
}

export function aiCalcFirstShot(tank, game) {
  const params = AI_PARAMS[tank.dif] || AI_PARAMS.normal;
  const target = tank.target;
  if (!target) return;

  tank.pRotace = 90 + pm(target.x - tank.x) * 45;
  tank.pX = tank.x;
  const dx = Math.abs(tank.x - target.x);
  if (params.firstWindComp) {
    // ai_very_hard exact formula
    tank.pPower =
      dx / (2 + dx / params.firstPowerDiv) -
      (pm(target.x - tank.x) * game.terrain.vitr) / 13 +
      (tank.y - target.y) / 20;
  } else {
    tank.pPower = dx / (2 + dx / params.firstPowerDiv);
  }
  if (tank.pPower >= tank.data.energy) {
    tank.pPower = tank.data.energy;
  }
  if (tank.pPower > 100) tank.pPower = 100;
  if (tank.pPower < 5) tank.pPower = 5;
}

export function aiCalcShot(tank, game) {
  const params = AI_PARAMS[tank.dif] || AI_PARAMS.normal;
  const target = tank.target;
  if (!target) return;

  const vitr = game.terrain.vitr;
  const lastWind = tank.lastWind;
  const x = tank.x;
  const y = tank.y;
  const rotace = tank.rotace;
  const power = tank.power;
  const lastShotX = tank.lastShotX;
  const lastShotY = tank.lastShotY;

  const lastShotVzd = Math.sqrt(
    Math.abs((x - lastShotX) * (x - lastShotX)) +
    Math.abs((y - lastShotY) * (y - lastShotY))
  );
  const targetVzd = Math.sqrt(
    Math.abs((x - target.x) * (x - target.x)) +
    Math.abs((y - target.y) * (y - target.y))
  );
  const xVzd = Math.abs(lastShotX - target.x);
  const yVzd = Math.abs(lastShotY - target.y);

  const windChangeKoef = params.windChangeKoef;
  let windKoefVzdKoef = params.windKoefVzdKoef;
  const vzdKoef = params.vzdKoef;
  const vzdKoefK = params.vzdKoefKBase + Math.abs(x - lastShotX) / 80;
  const yVzdKoef = params.yVzdKoef;
  let yKoef = params.yKoef;

  const rotR = params.rotRBase - (200 - Math.abs(x - target.x)) / 30;
  const rotL = params.rotLBase + (200 - Math.abs(x - target.x)) / 30;

  let pRotace = tank.pRotace;
  let pPower = tank.pPower;

  // Helper to guard against division by zero
  const safeDiv = (num, den) => (Math.abs(den) < 1e-6 ? 0 : num / den);

  if (x < target.x) {
    // Target is to the RIGHT (rotace in 90..180)
    windKoefVzdKoef -= (180 - rotace) * 3;
    yKoef += (135 - rotace) * 1.7;
    const windTerm = safeDiv(
      vitr - lastWind,
      windChangeKoef - safeDiv(Math.abs(lastShotX - x), windKoefVzdKoef)
    );
    const rotRadTerm = Math.abs(135 - rotace) / vzdKoefK;

    if (lastShotX < x) {
      pRotace = pRotace + (((x - lastShotX) / 10 + (target.x - x) / 20) - vitr / 50);
    } else if (
      lastShotVzd > 60 ||
      targetVzd < 70 ||
      (power < 10 && power < 70) ||
      lastShotVzd > 200
    ) {
      if (lastShotX >= target.x) {
        // Overshot to the right
        if (xVzd > 20) {
          pPower = pPower - (safeDiv(xVzd, vzdKoef + 2.5 - rotRadTerm) + windTerm - safeDiv(lastShotY - target.y, yKoef));
        } else {
          pPower = pPower - (safeDiv(xVzd, vzdKoef - 1 - rotRadTerm) + windTerm);
        }
      } else if (lastShotY < target.y) {
        // Short and above target
        if (target.y < y) {
          if (y - target.y > 80 && yVzd < 80 && yVzd > 20 && lastShotVzd < 100 && targetVzd > 220 && power > 30 && rotace > rotR - vitr / 7) {
            pRotace = pRotace - (((rotace - (rotR - vitr / 7)) / 4 + vitr / 20) - targetVzd / 100);
          } else if (rotace < rotR - vitr / 7) {
            pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) - windTerm + safeDiv(lastShotY - target.y, yKoef));
          } else if (yVzd < 30 && xVzd < 200) {
            pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) - windTerm + safeDiv(lastShotY - target.y, yKoef));
          } else if (yVzd >= 30) {
            if (target.x - x > 300 && power < 50 && rotace < 110) {
              pPower = pPower + (safeDiv(xVzd, vzdKoef / 3) - windTerm);
            } else if (rotace > rotR - vitr / 7) {
              if (pRotace <= 135) {
                pPower = pPower + (safeDiv(xVzd, vzdKoef * 2) - windTerm + yVzd / yVzdKoef + (135 - rotace) / 8 - vitr / 15 + (rotace - (rotR - vitr / 7)) / 8);
              } else {
                pPower = pPower + (safeDiv(xVzd, vzdKoef * 2) - windTerm + yVzd / yVzdKoef - vitr / 15);
              }
              pRotace = pRotace - ((rotace - (rotR - vitr / 7)) / 4.5 + yVzd / yVzdKoef);
            }
          }
        } else {
          if (target.y - y < 70 && yVzd < 100 && yVzd > 20 && lastShotVzd < 100 && targetVzd > 250 && power > 30 && rotace > rotR - vitr / 7) {
            pRotace = pRotace - (((rotace - (rotR - vitr / 7)) / 4.5 + vitr / 20) - targetVzd / 100);
          } else if (rotace < rotR - vitr / 7) {
            pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) - windTerm + safeDiv(lastShotY - target.y, yKoef));
          } else if (yVzd < 30 && xVzd < 200) {
            pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) - windTerm + safeDiv(lastShotY - target.y, yKoef));
          } else if (yVzd >= 30) {
            if (target.y - y > 200 && lastShotY > y) {
              if (pRotace > 120) {
                pPower = pPower + (safeDiv(xVzd, vzdKoef / 1.5) - windTerm);
              } else {
                pPower = pPower + (safeDiv(xVzd, vzdKoef / 2) - windTerm);
              }
            } else if (target.x - x > 300 && power < 50 && rotace < 110) {
              pPower = pPower + (safeDiv(xVzd, vzdKoef / 3) - windTerm);
            } else if (rotace > rotR - vitr / 7) {
              if (pRotace <= 135) {
                pPower = pPower + (safeDiv(xVzd, vzdKoef * 2) - windTerm - yVzd / yVzdKoef + (135 - rotace) / 8 - vitr / 15 + (rotace - (rotR - vitr / 7)) / 8);
              } else {
                pPower = pPower + (safeDiv(xVzd, vzdKoef * 2) - windTerm - yVzd / yVzdKoef - vitr / 15);
              }
              pRotace = pRotace - ((rotace - (rotR - vitr / 7)) / 4.5 + yVzd / yVzdKoef);
            }
          }
        }
      } else {
        // Short and below target
        if ((lastShotVzd < 150 && target.x - x >= 170 && lastShotVzd >= 100) || power < 30) {
          if (target.y < y) {
            pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) - windTerm + safeDiv(lastShotY - target.y, yKoef));
          } else if (target.y - y > 100) {
            pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) - windTerm);
          } else {
            pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) - windTerm + safeDiv(lastShotY - target.y, yKoef));
          }
        } else if (rotace < rotR - 5) {
          pRotace = pRotace + ((135 - rotace) / 10 + (target.x - x) / 100);
        } else {
          pRotace = pRotace - (rotace - (rotR - vitr / 7)) / 2;
          pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) / 1.5 + (rotace - (rotR - vitr / 7)) / 5);
        }
      }
    } else {
      // Blocked close to tank (hit nearby hill)
      if (y - target.y > 100 && target.x - x < 100) {
        pRotace = pRotace - (rotace - (rotR - vitr / 7)) / 2;
      } else {
        pRotace = pRotace - ((rotace - (rotR - vitr / 7)) / 2 - (target.x - x) / 100);
      }
    }
  } else {
    // Target is to the LEFT (rotace in 0..90)
    windKoefVzdKoef -= rotace * 3;
    yKoef += (rotace - 45) * 1.7;
    const windTerm = safeDiv(
      vitr - lastWind,
      windChangeKoef - safeDiv(Math.abs(lastShotX - x), windKoefVzdKoef)
    );
    const rotRadTerm = Math.abs(rotace - 45) / vzdKoefK;

    if (lastShotX > x) {
      pRotace = pRotace - (((lastShotX - x) / 10 + (x - target.x) / 20) + vitr / 50);
    } else if (
      lastShotVzd > 60 ||
      targetVzd < 70 ||
      (power < 10 && power < 70) ||
      lastShotVzd > 200
    ) {
      if (lastShotX <= target.x) {
        // Overshot to the left
        if (xVzd > 20) {
          pPower = pPower - (safeDiv(xVzd, vzdKoef + 2.5 - rotRadTerm) - windTerm - safeDiv(lastShotY - target.y, yKoef));
        } else {
          pPower = pPower - (safeDiv(xVzd, vzdKoef - 1 - rotRadTerm) - windTerm);
        }
      } else if (lastShotY < target.y) {
        // Short and above target
        if (target.y < y) {
          if (y - target.y > 80 && yVzd < 80 && yVzd > 20 && lastShotVzd < 100 && targetVzd > 220 && power > 30 && rotace > rotL + vitr / 7) {
            pRotace = pRotace + ((((rotL + vitr / 7) - rotace) / 4 - vitr / 20) - targetVzd / 100);
          } else if (rotace > rotL + vitr / 7) {
            pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) + windTerm + safeDiv(lastShotY - target.y, yKoef));
          } else if (yVzd < 30 && xVzd < 200) {
            pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) + windTerm + safeDiv(lastShotY - target.y, yKoef));
          } else if (yVzd >= 30) {
            if (x - target.x > 300 && power < 50 && rotace > 70) {
              pPower = pPower + (safeDiv(xVzd, vzdKoef / 3) + windTerm);
            } else if (rotace < rotL + vitr / 7) {
              if (pRotace >= 45) {
                pPower = pPower + (safeDiv(xVzd, vzdKoef * 2) + windTerm + yVzd / yVzdKoef + (rotace - 45) / 8 + vitr / 15 + ((rotL + vitr / 7) - rotace) / 8);
              } else {
                pPower = pPower + (safeDiv(xVzd, vzdKoef * 2) + windTerm + yVzd / yVzdKoef + vitr / 15);
              }
              pRotace = pRotace + (((rotL + vitr / 7) - rotace) / 4.5 + yVzd / yVzdKoef);
            }
          }
        } else {
          if (target.y - y < 70 && yVzd < 100 && yVzd > 20 && lastShotVzd < 100 && targetVzd > 250 && power > 30 && rotace < rotL - vitr / 7) {
            pRotace = pRotace + ((((rotL + vitr / 7) - rotace) / 4.5 - vitr / 20) - targetVzd / 100);
          } else if (rotace > rotL + vitr / 7) {
            pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) + windTerm + safeDiv(lastShotY - target.y, yKoef));
          } else if (yVzd < 30 && xVzd < 200) {
            pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) + windTerm + safeDiv(lastShotY - target.y, yKoef));
          } else if (yVzd >= 30) {
            if (target.y - y > 200 && lastShotY > y) {
              if (pRotace < 60) {
                pPower = pPower + (safeDiv(xVzd, vzdKoef / 1.5) + windTerm);
              } else {
                pPower = pPower + (safeDiv(xVzd, vzdKoef / 2) + windTerm);
              }
            } else if (x - target.x > 300 && power < 50 && rotace > 70) {
              pPower = pPower + (safeDiv(xVzd, vzdKoef / 3) + windTerm);
            } else if (rotace < rotL + vitr / 7) {
              if (pRotace >= 45) {
                pPower = pPower + (safeDiv(xVzd, vzdKoef * 2) + windTerm + yVzd / yVzdKoef + (rotace - 45) / 8 + vitr / 15 + ((rotL + vitr / 7) - rotace) / 8);
              } else {
                pPower = pPower + (safeDiv(xVzd, vzdKoef * 2) + windTerm + yVzd / yVzdKoef + vitr / 15);
              }
              pRotace = pRotace + (((rotL + vitr / 7) - rotace) / 4.5 + yVzd / yVzdKoef);
            }
          }
        }
      } else {
        // Short and below target
        if ((lastShotVzd < 150 && x - target.x >= 170 && lastShotVzd >= 100) || power < 30) {
          if (target.y < y) {
            pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) + windTerm + safeDiv(lastShotY - target.y, yKoef));
          } else if (target.y - y > 100) {
            pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) + windTerm);
          } else {
            pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) + windTerm + safeDiv(lastShotY - target.y, yKoef));
          }
        } else if (rotace > rotL + 5) {
          pRotace = pRotace - ((rotace - 45) / 10 + (x - target.x) / 100);
        } else {
          pRotace = pRotace + ((rotL + vitr / 7) - rotace) / 3;
          pPower = pPower + (safeDiv(xVzd, vzdKoef - rotRadTerm) / 1.5 + ((rotL + vitr / 7) - rotace) / 5);
        }
      }
    } else {
      if (y - target.y > 100 && x - target.x < 100) {
        pRotace = pRotace + ((rotL + vitr / 7) - rotace) / 2;
      } else {
        pRotace = pRotace + (((rotL + vitr / 7) - rotace) / 2 - (target.x - x) / 100);
      }
    }
  }

  // Clamp computed power and angle within valid bounds
  if (!Number.isFinite(pPower)) pPower = 50;
  if (!Number.isFinite(pRotace)) pRotace = x < target.x ? 135 : 45;

  if (pPower > 100) pPower = 100;
  if (pPower >= tank.data.energy) {
    pPower = tank.data.energy;
    if (x < target.x) {
      if (pRotace < 135) {
        if (pPower > 70) pPower -= (135 - pRotace) / 2.5;
        pRotace += (135 - pRotace) / 3;
      }
    } else if (pRotace > 45) {
      if (pPower > 70) pPower -= (pRotace - 45) / 2.5;
      pRotace -= (pRotace - 45) / 3;
    }
  }
  if (pPower < 0) pPower = 0;
  if (pRotace < 0) pRotace = 0;
  if (pRotace > 180) pRotace = 180;

  tank.pPower = pPower;
  tank.pRotace = pRotace;
}

export function aiPrepareShot(tank, game) {
  let prep = true;
  const targetRot = Math.max(0, Math.min(180, Math.ceil(tank.pRotace)));
  const maxPow = Math.min(100, Math.floor(tank.data.energy));
  const targetPow = Math.max(0, Math.min(maxPow, Math.ceil(tank.pPower)));

  const diffRot = Math.abs(tank.rotace - targetRot);
  const sp = diffRot < 10 ? 1 : Math.floor(diffRot / 10);

  if (Math.ceil(tank.rotace) !== targetRot) {
    if (targetRot < Math.ceil(tank.rotace)) {
      tank.rotace = Math.max(targetRot, tank.rotace - sp);
    } else {
      tank.rotace = Math.min(targetRot, tank.rotace + sp);
    }
    prep = false;
    game.sound.play(SOUNDS.TURRET_MOVE, { volume: 0.35, noMultiple: true });
  } else {
    game.sound.stop(SOUNDS.TURRET_MOVE);
  }

  const diffPow = Math.abs(tank.power - targetPow);
  const spPow = Math.max(1, diffPow < 10 ? 1 : Math.floor(diffPow / 10));
  if (Math.ceil(tank.power) !== targetPow) {
    if (targetPow < Math.ceil(tank.power)) {
      tank.power = Math.max(targetPow, tank.power - spPow);
    } else {
      tank.power = Math.min(targetPow, tank.power + spPow);
    }
    prep = false;
  }

  if (tank.pMove && Math.round(tank.pX) !== Math.round(tank.x) && tank.data.fuel > 0) {
    prep = false;
    if (Math.round(tank.pX) < Math.round(tank.x)) {
      tank.moveLeft(game.tanks);
    } else {
      tank.moveRight(game.tanks);
    }
  }

  return prep;
}

export function tickAI(tank, game) {
  if (!tank.playing || tank.type !== 'ai' || !tank.data.live) return;

  if (tank.firstFrame) {
    if (!tank.target || !tank.target.data.live) {
      tank.rounds = 1;
      aiSelectTarget(tank, game);
    }
    if (!tank.target) return;

    if (tank.rounds <= 1) {
      tank.firstShot = true;
      aiCalcFirstShot(tank, game);
    } else {
      aiCalcShot(tank, game);
    }
    tank.firstFrame = false;
  }

  if (aiPrepareShot(tank, game)) {
    tank.lastWind = game.terrain.vitr;
    tank.firstFrame = true;
    game.fireCurrentTank();
  }
}
