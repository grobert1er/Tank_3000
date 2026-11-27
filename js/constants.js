// Core gameplay constants, rebalanced weapon/special tables, and player defaults

export const STAGE_W = 550;
export const STAGE_H = 400;
export const FPS = 25;
export const FRAME_MS = 1000 / FPS;

// Balance & progression constants
export const MAX_UPGRADE_LEVEL = 5;
export const REPAIR_HEAL_AMOUNT = 15;
export const LEADER_BOUNTY = 4000;
export const ROUND_BASE_STIPEND = 3000;
export const ROUND_WIN_BONUS = 3000;
export const SUDDEN_DEATH_TURN = 16;

// Minimum firing power floor so low-HP tanks can still reach across the map
export function getMaxPower(energy) {
  return Math.min(100, Math.max(60, Math.round(energy)));
}

// Player color palette
export const PLAYER_COLORS = [
  0xF02400, // 15737856 Red
  0x00CC33, // 52275 Green
  0x0033FF, // 13311 Blue
  0x333333, // 3355443 Dark Grey (default)
  0xF0DF0F, // 15785743 Yellow
  0xEA9500, // 15373056 Orange
];

export const AI_DIFFICULTIES = ['Very_easy', 'easy', 'normal', 'hard', 'very_hard'];

export const AI_DIFFICULTY_LABELS = {
  Very_easy: 'Very easy',
  easy: 'Easy',
  normal: 'Normal',
  hard: 'Hard',
  very_hard: 'Very hard',
};

export const BALANCE_PRESETS = ['balanced', 'classic'];

// Re-tiered weapon catalog
export const WEAPONS = [
  { id: 0,  icon: 'bmissile', name: 'Small missile',   price: 0,     pack: 0,  proj: 'bmissile_g',  spriteId: 68, soundId: 46, kind: 'missile', f6w: 19.79, f6h: 9.5,  par1: 15, par2: 7.5, par3: 15, par4: 5,  par5: 13 },
  { id: 1,  icon: 'missile',  name: 'Missile',         price: 2000,  pack: 8,  proj: 'missile_g',   spriteId: 66, soundId: 46, kind: 'missile', f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 18 },
  { id: 2,  icon: 'bnuke',    name: 'Small atom bomb', price: 5500,  pack: 2,  proj: 'bnuke_g',     spriteId: 40, soundId: 39, kind: 'missile', f6w: 91.74, f6h: 44.1, par1: 30, par2: 15,  par3: 15, par4: 17, par5: 24 },
  { id: 3,  icon: 'nuke',     name: 'Atom bomb',       price: 14000, pack: 1,  proj: 'nuke_g',      spriteId: 37, soundId: 35, kind: 'missile', f6w: 191.70,f6h: 92.1, par1: 35, par2: 30,  par3: 30, par4: 22, par5: 40 },
  { id: 4,  icon: 'funky',    name: 'Volcano bomb',    price: 6500,  pack: 2,  proj: 'funky_g',     spriteId: 47, soundId: 46, kind: 'funky',   f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 18 },
  { id: 5,  icon: 'mirv',     name: 'Shower',          price: 7500,  pack: 2,  proj: 'mirv_g',      spriteId: 44, soundId: 39, kind: 'mirv',    f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 18 },
  { id: 6,  icon: 'death',    name: 'Hot shower',      price: 24000, pack: 1,  proj: 'death_g',     spriteId: 42, soundId: 35, kind: 'death',   f6w: 91.74, f6h: 44.1, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 20 },
  { id: 7,  icon: 'broller',  name: 'Small ball',      price: 3500,  pack: 4,  proj: 'broller_g',   spriteId: 61, soundId: 46, kind: 'roller',  f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 20, uphill: false },
  { id: 8,  icon: 'roller',   name: 'Ball',            price: 5500,  pack: 2,  proj: 'roller_g',    spriteId: 58, soundId: 39, kind: 'roller',  f6w: 91.74, f6h: 44.1, par1: 30, par2: 15,  par3: 15, par4: 13, par5: 18, uphill: false },
  { id: 9,  icon: 'hroller',  name: 'Large ball',      price: 13000, pack: 1,  proj: 'hroller_g',   spriteId: 55, soundId: 35, kind: 'roller',  f6w: 191.70,f6h: 92.1, par1: 35, par2: 30,  par3: 30, par4: 19, par5: 36, uphill: false },
  { id: 10, icon: 'broller2', name: 'Small ball V2',   price: 4500,  pack: 4,  proj: 'broller2_g',  spriteId: 61, soundId: 46, kind: 'roller',  f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 20, uphill: true },
  { id: 11, icon: 'roller2',  name: 'Ball V2',         price: 6500,  pack: 2,  proj: 'roller2_g',   spriteId: 58, soundId: 39, kind: 'roller',  f6w: 91.74, f6h: 44.1, par1: 30, par2: 15,  par3: 15, par4: 13, par5: 18, uphill: true },
  { id: 12, icon: 'hroller2', name: 'Large ball V2',   price: 15000, pack: 1,  proj: 'hroller2_g',  spriteId: 55, soundId: 35, kind: 'roller',  f6w: 191.70,f6h: 92.1, par1: 35, par2: 30,  par3: 30, par4: 19, par5: 36, uphill: true },
  { id: 13, icon: 'astrike',  name: 'Air strike',      price: 18000, pack: 1,  proj: 'astrike_g',   spriteId: 64, soundId: 35, kind: 'astrike', f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 18 },
];

// Sub-munition specs (bnuke_c for Hot shower, missile_funky for Volcano/Shower, amissile for Air strike)
export const SUB_WEAPONS = {
  bnuke_c:       { spriteId: 49, soundId: 39, f6w: 91.74, f6h: 44.1, par1: 30, par2: 15,  par3: 15, par4: 17, par5: 24 },
  missile_funky: { spriteId: 53, soundId: 46, f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 18 },
  amissile:      { spriteId: 51, soundId: 39, f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 18 },
};

// Rebalanced special items and capped permanent upgrades (max level 5 for indices 8..11)
export const SPECIALS = [
  { id: 0,  icon: 'par',      name: 'Parachutes',        price: 3000,  pack: 3 },
  { id: 1,  icon: 'repair',   name: 'Repair kit',        price: 3500,  pack: 4 },
  { id: 2,  icon: 'fuel',     name: 'Fuel',              price: 2500,  pack: 60 },
  { id: 3,  icon: 'sshield',  name: 'Weak shield',       price: 3500,  pack: 2, shieldLink: 'weak_sh',   shieldMax: 50 },
  { id: 4,  icon: 'shield',   name: 'Shield',            price: 6500,  pack: 1, shieldLink: 'shield_sh', shieldMax: 100 },
  { id: 5,  icon: 'stshield', name: 'Strong shield',     price: 11000, pack: 1, shieldLink: 'strong_sh', shieldMax: 175 },
  { id: 6,  icon: 'spshield', name: 'Super shield',      price: 16000, pack: 1, shieldLink: 'super_sh',  shieldMax: 250 },
  { id: 7,  icon: 'teleport', name: 'Teleport',          price: 10000, pack: 1 },
  { id: 8,  icon: 'upenergy', name: 'Upgrade energy',    price: 5000,  pack: 1, maxLevel: MAX_UPGRADE_LEVEL },
  { id: 9,  icon: 'uparmor',  name: 'Upgrade armor',     price: 8000,  pack: 1, maxLevel: MAX_UPGRADE_LEVEL },
  { id: 10, icon: 'upmove',   name: 'Upgrade engine',    price: 5000,  pack: 1, maxLevel: MAX_UPGRADE_LEVEL },
  { id: 11, icon: 'uphill',   name: 'Upgrade hill move', price: 4000,  pack: 1, maxLevel: MAX_UPGRADE_LEVEL },
];

export const SHIELD_TIERS = [
  null,
  { tier: 1, specialIdx: 3, sprite: 'weak_sh',   maxEnergy: 50 },
  { tier: 2, specialIdx: 4, sprite: 'shield_sh', maxEnergy: 100 },
  { tier: 3, specialIdx: 5, sprite: 'strong_sh', maxEnergy: 175 },
  { tier: 4, specialIdx: 6, sprite: 'super_sh',  maxEnergy: 250 },
];

// Tank collision geometry
export const TANK_WIDTH = 16.0;
export const TANK_HEIGHT = 6.5;
export const TANK_HALF_W = 8.0;
export const TANK_HALF_H = 3.25;
export const TANK_PASY_LEFT = -4.8;
export const TANK_PASY_RIGHT = 4.8;
export const TANK_PASY_TOP = 2.5;
export const TANK_PASY_BOTTOM = 4.1;
export const TANK_DEATH_EXPL_W = 70.0;
export const TANK_DEATH_EXPL_H = 40.0;

// Shield bounding radius
export const SHIELD_RADIUS = 21.4;

// Sound asset IDs
export const SOUNDS = {
  TANK_EXPLODE: 12,
  NUKE_EXPLODE: 35,
  MEDIUM_EXPLODE: 39,
  SMALL_EXPLODE: 46,
  UI_CLICK: 121,
  CLONA_DOOR: 246,
  TURRET_MOVE: 346,
};

// HUD panel stage anchor
export const PANEL_X = 442.6;
export const PANEL_Y = 28.4;

// Create initial player tank record ('balanced' lean kit by default, or 'classic' overloaded kit)
export function createInitialTankData(
  tNum,
  name = '',
  col = 0x333333,
  type = 'tank',
  dif = 'normal',
  preset = 'balanced'
) {
  const guns = new Array(WEAPONS.length).fill(0);
  const specials = new Array(SPECIALS.length).fill(0);
  let startCash = 4000;
  let startFuel = 100;

  if (preset === 'classic') {
    // Classic / Chaos overloaded starting loadout
    guns[0] = 99;
    guns[4] = 100;
    specials[0] = 8;
    specials[1] = 8;
    specials[2] = 250;
    specials[3] = 8;
    specials[4] = 8;
    specials[5] = 8;
    specials[6] = 8;
    specials[7] = 8;
    startCash = 5000;
    startFuel = 250;
  } else {
    // Balanced lean starting loadout so the Shop matters from Round 1
    guns[0] = 99;     // Small missile (infinite)
    guns[1] = 3;      // 3 Missiles
    guns[4] = 1;      // 1 Volcano bomb
    specials[0] = 2;  // 2 Parachutes
    specials[1] = 2;  // 2 Repair kits
    specials[2] = 100;// 100 Fuel
    specials[3] = 1;  // 1 Weak shield
    startCash = 4000;
    startFuel = 100;
  }

  return {
    t_num: tNum,
    name: name || `Player ${tNum}`,
    col,
    type, // 'tank' | 'ai'
    dif,  // 'Very_easy' | 'easy' | 'normal' | 'hard' | 'very_hard'
    guns,
    specials,
    cur_gun: 0,
    energy: 100,
    max_energy: 100,
    shield: 1,
    fuel: startFuel,
    score: startCash,
    total_score: 0,
    live: true,
    kills: 0,
  };
}
