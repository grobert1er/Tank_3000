// Core gameplay constants, weapon/special tables, AI parameters, and player defaults

export const STAGE_W = 550;
export const STAGE_H = 400;
export const FPS = 25;
export const FRAME_MS = 1000 / FPS;

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

// Weapon catalog
export const WEAPONS = [
  { id: 0,  icon: 'bmissile', name: 'Small missile',   price: 0,     pack: 0,  proj: 'bmissile_g',  spriteId: 68, soundId: 46, kind: 'missile', f6w: 19.79, f6h: 9.5,  par1: 15, par2: 7.5, par3: 15, par4: 5,  par5: 13 },
  { id: 1,  icon: 'missile',  name: 'Missile',         price: 2000,  pack: 10, proj: 'missile_g',   spriteId: 66, soundId: 46, kind: 'missile', f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 18 },
  { id: 2,  icon: 'bnuke',    name: 'Small atom bomb', price: 5000,  pack: 2,  proj: 'bnuke_g',     spriteId: 40, soundId: 39, kind: 'missile', f6w: 91.74, f6h: 44.1, par1: 30, par2: 15,  par3: 15, par4: 17, par5: 24 },
  { id: 3,  icon: 'nuke',     name: 'Atom bomb',       price: 13000, pack: 1,  proj: 'nuke_g',      spriteId: 37, soundId: 35, kind: 'missile', f6w: 191.70,f6h: 92.1, par1: 35, par2: 30,  par3: 30, par4: 22, par5: 40 },
  { id: 4,  icon: 'funky',    name: 'Volcano bomb',    price: 8000,  pack: 2,  proj: 'funky_g',     spriteId: 47, soundId: 46, kind: 'funky',   f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 18 },
  { id: 5,  icon: 'mirv',     name: 'Shower',          price: 9000,  pack: 2,  proj: 'mirv_g',      spriteId: 44, soundId: 39, kind: 'mirv',    f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 18 },
  { id: 6,  icon: 'death',    name: 'Hot shower',      price: 30000, pack: 1,  proj: 'death_g',     spriteId: 42, soundId: 35, kind: 'death',   f6w: 91.74, f6h: 44.1, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 20 },
  { id: 7,  icon: 'broller',  name: 'Small ball',      price: 5000,  pack: 5,  proj: 'broller_g',   spriteId: 61, soundId: 46, kind: 'roller',  f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 20, uphill: false },
  { id: 8,  icon: 'roller',   name: 'Ball',            price: 6000,  pack: 2,  proj: 'roller_g',    spriteId: 58, soundId: 39, kind: 'roller',  f6w: 91.74, f6h: 44.1, par1: 30, par2: 15,  par3: 15, par4: 13, par5: 18, uphill: false },
  { id: 9,  icon: 'hroller',  name: 'Large ball',      price: 15000, pack: 1,  proj: 'hroller_g',   spriteId: 55, soundId: 35, kind: 'roller',  f6w: 191.70,f6h: 92.1, par1: 35, par2: 30,  par3: 30, par4: 19, par5: 36, uphill: false },
  { id: 10, icon: 'broller2', name: 'Small ball V2',   price: 6500,  pack: 5,  proj: 'broller2_g',  spriteId: 61, soundId: 46, kind: 'roller',  f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 20, uphill: true },
  { id: 11, icon: 'roller2',  name: 'Ball V2',         price: 7500,  pack: 2,  proj: 'roller2_g',   spriteId: 58, soundId: 39, kind: 'roller',  f6w: 91.74, f6h: 44.1, par1: 30, par2: 15,  par3: 15, par4: 13, par5: 18, uphill: true },
  { id: 12, icon: 'hroller2', name: 'Large ball V2',   price: 18000, pack: 1,  proj: 'hroller2_g',  spriteId: 55, soundId: 35, kind: 'roller',  f6w: 191.70,f6h: 92.1, par1: 35, par2: 30,  par3: 30, par4: 19, par5: 36, uphill: true },
  { id: 13, icon: 'astrike',  name: 'Air strike',      price: 25000, pack: 1,  proj: 'astrike_g',   spriteId: 64, soundId: 35, kind: 'astrike', f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 18 },
];

// Sub-munition specs (bnuke_c for Hot shower, missile_funky for Volcano/Shower, amissile for Air strike)
export const SUB_WEAPONS = {
  bnuke_c:       { spriteId: 49, soundId: 39, f6w: 91.74, f6h: 44.1, par1: 30, par2: 15,  par3: 15, par4: 17, par5: 24 },
  missile_funky: { spriteId: 53, soundId: 46, f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 18 },
  amissile:      { spriteId: 51, soundId: 39, f6w: 35.00, f6h: 16.7, par1: 15, par2: 7.5, par3: 15, par4: 13, par5: 18 },
};

// Special items and upgrades catalog
export const SPECIALS = [
  { id: 0,  icon: 'par',      name: 'Parachutes',        price: 5000,  pack: 5 },
  { id: 1,  icon: 'repair',   name: 'Repair kit',        price: 4000,  pack: 5 },
  { id: 2,  icon: 'fuel',     name: 'Fuel',              price: 3000,  pack: 50 },
  { id: 3,  icon: 'sshield',  name: 'Weak shield',       price: 5000,  pack: 2, shieldLink: 'weak_sh',   shieldMax: 100 },
  { id: 4,  icon: 'shield',   name: 'Shield',            price: 10000, pack: 1, shieldLink: 'shield_sh', shieldMax: 200 },
  { id: 5,  icon: 'stshield', name: 'Strong shield',     price: 15000, pack: 1, shieldLink: 'strong_sh', shieldMax: 400 },
  { id: 6,  icon: 'spshield', name: 'Super shield',      price: 20000, pack: 1, shieldLink: 'super_sh',  shieldMax: 600 },
  { id: 7,  icon: 'teleport', name: 'Teleport',          price: 15000, pack: 1 },
  { id: 8,  icon: 'upenergy', name: 'Upgrade energy',    price: 5000,  pack: 1 },
  { id: 9,  icon: 'uparmor',  name: 'Upgrade armor',     price: 10000, pack: 1 },
  { id: 10, icon: 'upmove',   name: 'Upgrade engine',    price: 7000,  pack: 1 },
  { id: 11, icon: 'uphill',   name: 'Upgrade hill move', price: 5000,  pack: 1 },
];

export const SHIELD_TIERS = [
  null,
  { tier: 1, specialIdx: 3, sprite: 'weak_sh',   maxEnergy: 100 },
  { tier: 2, specialIdx: 4, sprite: 'shield_sh', maxEnergy: 200 },
  { tier: 3, specialIdx: 5, sprite: 'strong_sh', maxEnergy: 400 },
  { tier: 4, specialIdx: 6, sprite: 'super_sh',  maxEnergy: 600 },
];

// AI difficulty coefficient tables
export const AI_PARAMS = {
  Very_easy: {
    firstPowerDiv: 120,
    firstWindComp: false,
    windChangeKoef: 7,
    windKoefVzdKoef: 380,
    vzdKoef: 10.9,
    vzdKoefKBase: 7,
    yVzdKoef: 30,
    yKoef: 22,
    rotRBase: 100,
    rotLBase: 80,
    rotLCheckFlip: false,
  },
  easy: {
    firstPowerDiv: 120,
    firstWindComp: false,
    windChangeKoef: 99999,
    windKoefVzdKoef: 380000,
    vzdKoef: 25,
    vzdKoefKBase: 15,
    yVzdKoef: 3000,
    yKoef: 22000,
    rotRBase: 100,
    rotLBase: 80,
    rotLCheckFlip: false,
  },
  normal: {
    firstPowerDiv: 110,
    firstWindComp: false,
    windChangeKoef: 15,
    windKoefVzdKoef: 500,
    vzdKoef: 18,
    vzdKoefKBase: 12,
    yVzdKoef: 50,
    yKoef: 40,
    rotRBase: 106,
    rotLBase: 74,
    rotLCheckFlip: false,
  },
  hard: {
    firstPowerDiv: 80,
    firstWindComp: false,
    windChangeKoef: 11,
    windKoefVzdKoef: 420,
    vzdKoef: 14,
    vzdKoefKBase: 9,
    yVzdKoef: 40,
    yKoef: 30,
    rotRBase: 102,
    rotLBase: 78,
    rotLCheckFlip: false,
  },
  very_hard: {
    firstPowerDiv: 80,
    firstWindComp: true,
    windChangeKoef: 7,
    windKoefVzdKoef: 380,
    vzdKoef: 10.9,
    vzdKoefKBase: 7,
    yVzdKoef: 30,
    yKoef: 22,
    rotRBase: 100,
    rotLBase: 80,
    rotLCheckFlip: false,
  },
};

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

// Create initial player tank record
export function createInitialTankData(tNum, name = '', col = 0x333333, type = 'tank', dif = 'normal') {
  const guns = new Array(WEAPONS.length).fill(0);
  const specials = new Array(SPECIALS.length).fill(0);
  // Default starting inventory
  guns[0] = 99;
  guns[4] = 100; // 100 Volcano bombs
  specials[0] = 8;   // Parachutes
  specials[1] = 8;   // Repair kits
  specials[2] = 250; // Fuel
  specials[3] = 8;   // Weak shield
  specials[4] = 8;   // Shield
  specials[5] = 8;   // Strong shield
  specials[6] = 8;   // Super shield
  specials[7] = 8;   // Teleport

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
    fuel: 500,
    score: 5000,
    total_score: 0,
    live: true,
    kills: 0,
  };
}
