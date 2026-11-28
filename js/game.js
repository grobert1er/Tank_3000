// Master 25Hz Game Controller, Scene State Machine, Battle Simulation, Economy & Shop

import {
  STAGE_W, STAGE_H, FPS,
  PLAYER_COLORS, WEAPONS, SPECIALS, SOUNDS,
  MAX_UPGRADE_LEVEL, REPAIR_HEAL_AMOUNT, ROUND_BASE_STIPEND, ROUND_WIN_BONUS,
  SUDDEN_DEATH_TURN, getMaxPower, createInitialTankData,
} from './constants.js';
import { RNG } from './rng.js';
import { Terrain } from './terrain.js';
import { Tank } from './tank.js';
import { Projectile, AirStrikeController, TeleportController, spawnAirStrikeBombs, getWeaponSpec } from './weapons.js';
import { tickAI, aiBuyInShop } from './ai.js';
import { VfxManager } from './vfx.js';

function hexIntToCss(col) {
  return '#' + ((col ?? 0x333333) >>> 0).toString(16).padStart(6, '0');
}

export class TankGame {
  constructor(renderer, sound, callbacks = {}) {
    this.renderer = renderer;
    this.sound = sound;
    this.cb = callbacks; // { onOnlineAction, onOnlineAim, onOnlineShopBuy, onOnlineShopReady, onStatusChange, onAutoSave }

    this.rng = new RNG();
    this.aiRng = new RNG(Date.now() ^ 0x5a5a5a5a);
    this.terrain = new Terrain();
    this.vfx = new VfxManager();

    // Game mode: 'local' | 'online'
    this.mode = 'local';
    this.mySlot = 0; // 1..5 in online mode
    this.isHost = true;
    this.onlineReadySent = false;
    this.onlineReadyStatus = '';
    this._pendingStateSync = null;
    this._pendingStateSyncWait = 0;

    // Balance & anti-stall settings
    this.balancePreset = 'balanced'; // 'balanced' | 'classic'
    this.turnTimerSec = 0;           // 0 (Off) | 20 | 30
    this.turnTicksLeft = 0;
    this.roundTurns = 0;
    this.pendingStrikes = [];
    this.bannerToast = null; // { text, color, frames }
    this._roundPayoutAwarded = false;
    this.fastForward = false; // 4x simulation speed when only AI bots remain alive

    // Scene state: 'menu1' | 'menu2' | 'loading' | 'battle' | 'shop'
    this.scene = 'menu1';
    this.quality = 'HIGH';

    // Match setup state
    this.krajinaSetting = 0; // 0=Random, 1=Mountains, 2=Forest, 3=Desert
    this.randKrajina = true;
    this.playerCount = 2; // 2..5

    // Persistent players array (1-indexed via index = t_num - 1)
    this.playerData = [];
    this.gameRound = 0;

    // Active battle state
    this.tanks = [];
    this.turnOrder = [];
    this.turnIdx = 0;
    this.activeTank = null;
    this.nextTank = null;
    this.aliveCount = 0;
    this.testing = false;
    this.shotFlying = false;
    this.roundEndPending = false;
    this.roundTransitioning = false;
    this.roundEndTimer = 0;
    this.projectiles = [];
    this.airStrike = null;
    this.teleport = null;
    this._aiPendingAirStrike = null;
    this._aiPendingTeleport = null;
    this.blik = null; // { x, y, frame, col }

    // HUD interactive hold state
    this.shieldsMenuOpen = false;
    this.draggingAngle = false;
    this.holdingFuelLeft = false;
    this.holdingFuelRight = false;

    // Shop state
    this.shopCur = 0; // 1..N player currently shopping

    // Pointer tracking in stage coords (0..550, 0..400) for Air Strike & Teleport
    this.mouseX = 275;
    this.mouseY = 200;
    this.mouseDown = false;
    this.cursorHidden = false;

    // Keyboard live state
    this.keys = {
      left: false,
      right: false,
      angleUp: false,
      angleDown: false,
      powerUp: false,
      powerDown: false,
      fire: false,
    };

    // Network live-aim throttling
    this._aimSyncCounter = 0;
    this._lastSentAim = '';

    // Boot straight into a scenic Paper-Cut panorama behind the Title overlay
    this._initTitlePanorama(1);
  }

  // ==================== SCENIC BACKDROP & SCENE INITIALIZERS ====================

  _initTitlePanorama(biome = 1) {
    const k = biome >= 1 && biome <= 3 ? biome : 1;
    const previewRng = new RNG(20261128 + k * 7919);
    this.terrain.beginGenerate(k, previewRng, true);
    this.terrain.vitr = k === 1 ? 14 : k === 2 ? 10 : 18;
    this.vfx.clearBattleFx();
  }

  setTitlePreviewBiome(krajinaSetting) {
    this.krajinaSetting = Number(krajinaSetting) || 0;
    this.randKrajina = this.krajinaSetting === 0;
    if (this.scene === 'menu1' || this.scene === 'menu2') {
      this._initTitlePanorama(this.krajinaSetting === 0 ? 1 : this.krajinaSetting);
    }
  }

  resetToTitle() {
    this.mode = 'local';
    this.mySlot = 0;
    this.isHost = true;
    this.scene = 'menu1';
    this.tanks = [];
    this.projectiles = [];
    this.airStrike = null;
    this.teleport = null;
    this.pendingStrikes = [];
    this.bannerToast = null;
    this.roundTurns = 0;
    this.turnTicksLeft = 0;
    this.fastForward = false;
    this.blik = null;
    this.shieldsMenuOpen = false;
    this.cursorHidden = false;
    this.clearKeys();
    this._initTitlePanorama(this.krajinaSetting === 0 ? 1 : this.krajinaSetting);
    this._notifyStatus();
  }

  openLocalSetup() {
    this.mode = 'local';
    this.mySlot = 0;
    this.isHost = true;
    this.scene = 'menu2';
    this.setTitlePreviewBiome(this.krajinaSetting);
    this._notifyStatus();
  }

  // Instant HTML-card local match launcher
  startLocalMatch({ krajina = 0, preset = 'balanced', turnTimer = 0, players = [] } = {}) {
    if (!Array.isArray(players) || players.length < 2) return;
    this.mode = 'local';
    this.mySlot = 0;
    this.isHost = true;
    this.krajinaSetting = Number(krajina) || 0;
    this.randKrajina = this.krajinaSetting === 0;
    this.setBalancePreset(preset);
    this.setTurnTimer(turnTimer);

    const capped = players.slice(0, 5);
    this.playerCount = capped.length;
    this.gameRound = 0;
    this.pendingStrikes = [];
    this.bannerToast = null;
    this.playerData = capped.map((p, idx) =>
      createInitialTankData(
        idx + 1,
        (p.name || '').trim() || `Player ${idx + 1}`,
        p.col ?? PLAYER_COLORS[idx % PLAYER_COLORS.length],
        p.type === 'ai' ? 'ai' : 'tank',
        p.dif || 'normal',
        this.balancePreset
      )
    );
    this.rng = new RNG();
    this.aiRng = new RNG(Date.now() ^ 0x5a5a5a5a);
    this._pendingStateSync = null;
    this._pendingStateSyncWait = 0;
    this._startNextRound();
  }

  // True during battle when >= 2 tanks are alive and ALL surviving tanks are AI bots
  isBotsOnlyAlive() {
    if (this.scene !== 'battle' || this.aliveCount < 2) return false;
    let aiAlive = 0;
    for (const t of this.tanks) {
      if (t.data.live && t.data.energy > 0 && !t.dead) {
        if (t.type !== 'ai') return false;
        aiAlive++;
      }
    }
    return aiAlive >= 2;
  }

  getSimSpeed() {
    return this.fastForward && this.isBotsOnlyAlive() ? 4 : 1;
  }

  setFastForward(enabled, fromRemote = false) {
    if (!fromRemote && this.mode === 'online' && !this.isHost) return false;
    const next = Boolean(enabled) && this.isBotsOnlyAlive();
    if (this.fastForward === next) return this.fastForward;
    this.fastForward = next;
    if (!fromRemote && this.mode === 'online' && this.isHost) {
      this.cb.onOnlineAction?.({
        type: 'fast_forward',
        enabled: this.fastForward,
      });
    }
    return this.fastForward;
  }

  setBalancePreset(preset) {
    this.balancePreset = preset === 'classic' ? 'classic' : 'balanced';
  }

  setTurnTimer(sec) {
    const s = Number(sec) || 0;
    this.turnTimerSec = [0, 20, 30].includes(s) ? s : 0;
  }

  showToast(text, color = '#0284c7', frames = 65) {
    this.bannerToast = { text, color, frames };
  }

  // Sudden Death escalating damage multiplier to prevent endless rounds
  getDamageMultiplier() {
    const sdStart = this.balancePreset === 'classic' ? 20 : SUDDEN_DEATH_TURN;
    if (this.roundTurns < sdStart) return 1;
    const steps = Math.floor((this.roundTurns - sdStart) / 4);
    return Math.min(3.0, 1.5 + steps * 0.5);
  }

  // True iff tankNumber is the sole #1 scoreboard leader with total_score > 0
  isScoreLeader(tankNumber) {
    if (!this.playerData || this.playerData.length < 2) return false;
    let topScore = 0;
    let topCount = 0;
    let topNum = 0;
    for (const pd of this.playerData) {
      if (pd.total_score > topScore) {
        topScore = pd.total_score;
        topCount = 1;
        topNum = pd.t_num;
      } else if (pd.total_score === topScore && topScore > 0) {
        topCount++;
      }
    }
    return topScore > 0 && topCount === 1 && topNum === tankNumber;
  }

  // Start an online multiplayer match from lobby config (or resume a saved match!)
  startOnlineMatch({ seed, krajina, players, mySlot, isHost, preset, turnTimer, savedState }) {
    this.mode = 'online';
    this.mySlot = mySlot;
    this.isHost = Boolean(isHost);
    if (preset) this.setBalancePreset(preset);
    if (turnTimer !== undefined) this.setTurnTimer(turnTimer);

    if (savedState) {
      this.loadSaveData(savedState, {
        mode: 'online',
        mySlot,
        isHost: Boolean(isHost),
        slotOverrides: players,
        turnTimerSec: turnTimer,
      });
      return;
    }

    this.krajinaSetting = krajina;
    this.randKrajina = krajina === 0;
    this.playerCount = players.length;
    this.gameRound = 0;
    this.pendingStrikes = [];
    this.bannerToast = null;
    this.playerData = players.map((p, idx) =>
      createInitialTankData(
        idx + 1,
        p.name || `Player ${idx + 1}`,
        p.col ?? PLAYER_COLORS[idx % PLAYER_COLORS.length],
        p.type || 'tank',
        p.dif || 'normal',
        this.balancePreset
      )
    );
    this.rng.setSeed(seed);
    this.aiRng.setSeed((seed ^ 0x5a5a5a5a) >>> 0);
    this._pendingStateSync = null;
    this._pendingStateSyncWait = 0;
    this._startNextRound();
  }

  // Start next round in online mode with server-provided seed
  startOnlineNextRound(seed) {
    this.onlineReadySent = false;
    this.onlineReadyStatus = '';
    this._pendingStateSync = null;
    this._pendingStateSyncWait = 0;
    this.rng.setSeed(seed);
    this.aiRng.setSeed((seed ^ 0x5a5a5a5a) >>> 0);
    this._startNextRound();
  }

  _prepareRoundData() {
    for (const pd of this.playerData) {
      pd.live = true;
      const energyLvl = Math.min(MAX_UPGRADE_LEVEL, pd.specials[8] || 0);
      pd.max_energy = 100 + energyLvl * 10;
      pd.energy = pd.max_energy;
      pd.fuel = pd.specials[2];
    }
    this.roundTurns = 0;
    this.pendingStrikes = [];
    this._roundPayoutAwarded = false;
    this.gameRound += 1;
  }

  _startNextRound() {
    this._prepareRoundData();
    this.vfx.clearBattleFx();
    this.tanks = [];
    this.projectiles = [];
    this.airStrike = null;
    this.teleport = null;
    this.pendingStrikes = [];
    this.fastForward = false;
    this.blik = null;
    this.shieldsMenuOpen = false;
    this.cursorHidden = false;
    this.terrain.beginGenerate(this.krajinaSetting, this.rng, true);
    this._enterBattle();
  }

  // Tank spawning & turn order setup
  _enterBattle() {
    this.scene = 'battle';
    this.tanks = [];
    this.projectiles = [];
    this.airStrike = null;
    this.teleport = null;
    this.pendingStrikes = [];
    this._aiPendingAirStrike = null;
    this._aiPendingTeleport = null;
    this.blik = null;
    this.shieldsMenuOpen = false;
    this.draggingAngle = false;
    this.holdingFuelLeft = false;
    this.holdingFuelRight = false;
    this.shotFlying = false;
    this.roundEndPending = false;
    this.roundTransitioning = false;
    this.roundEndTimer = 0;
    this._roundPayoutAwarded = false;
    this.roundTurns = 0;
    this.turnTicksLeft = 0;
    this.fastForward = false;

    // Fairer spawns: stay well away from screen edges (x = 45..505)
    const minSep = 320 / this.playerCount;
    for (let i = 0; i < this.playerCount; i++) {
      const pd = this.playerData[i];
      let tx = this.rng.random(460) + 45;
      let guard = 0;
      while (this.terrain.topY(tx) > STAGE_H && guard++ < 500) {
        tx = this.rng.random(460) + 45;
      }
      let f = 0;
      let sepGuard = 0;
      while (f < i && sepGuard++ < 1500) {
        const otherX = this.tanks[f].x;
        if (tx < otherX + minSep && tx > otherX - minSep) {
          tx = this.rng.random(460) + 45;
          let g2 = 0;
          while (this.terrain.topY(tx) > STAGE_H && g2++ < 500) {
            tx = this.rng.random(460) + 45;
          }
          f = 0;
          continue;
        }
        f++;
      }
      const tank = new Tank(pd, tx, this.terrain, this.rng);
      this.tanks.push(tank);
    }

    // Sort round turn order strictly from lowest total_score to highest total_score,
    // breaking equal-score ties via deterministic seeded roll
    const tieRolls = new Map();
    for (const tk of this.tanks) {
      tieRolls.set(tk.tankNumber, this.rng.random(100000));
    }
    this.turnOrder = [...this.tanks].sort(
      (a, b) =>
        a.data.total_score - b.data.total_score ||
        (tieRolls.get(a.tankNumber) - tieRolls.get(b.tankNumber)) ||
        a.tankNumber - b.tankNumber
    );
    this.turnIdx = 0;
    this.nextTank = this.turnOrder[0] || null;
    this.activeTank = null;
    this.aliveCount = this.playerCount;

    // Settle all tanks before starting the first turn
    this.triggerTest();
    this._notifyStatus();
  }

  // Anti-snowball round-end payouts: base stipend + survivor bonus + underdog catch-up cash
  _awardRoundEndPayouts() {
    if (this._roundPayoutAwarded) return;
    this._roundPayoutAwarded = true;

    const survivor = this.tanks.find((t) => t.data.live && t.data.energy > 0) || null;
    const ranked = [...this.playerData].sort(
      (a, b) => b.total_score - a.total_score || a.t_num - b.t_num
    );
    const leaderScore = ranked[0]?.total_score ?? 0;

    for (let i = 0; i < ranked.length; i++) {
      const pd = ranked[i];
      pd.score += ROUND_BASE_STIPEND;
      if (i > 0 && pd.total_score < leaderScore) {
        pd.score += i * 1000;
      }
    }

    if (survivor) {
      survivor.data.score += ROUND_WIN_BONUS;
      survivor.data.total_score += ROUND_WIN_BONUS;
      this.showToast(
        `${survivor.data.name} WINS! +$${ROUND_WIN_BONUS.toLocaleString()} · Stipend +$${ROUND_BASE_STIPEND.toLocaleString()}`,
        '#16a34a',
        75
      );
    } else {
      this.showToast(`DRAW ROUND! Stipend +$${ROUND_BASE_STIPEND.toLocaleString()}`, '#d97706', 70);
    }
  }

  // Trigger any delayed Air Strike whose 1-turn warning has elapsed; returns true if bombs dropped
  _processPendingStrikes() {
    if (!this.pendingStrikes.length || !this.activeTank) return false;
    const due = [];
    const remaining = [];
    for (const s of this.pendingStrikes) {
      if (s.justPlanted) {
        s.justPlanted = false;
        remaining.push(s);
      } else {
        s.turnsLeft = (s.turnsLeft ?? 1) - 1;
        if (s.turnsLeft <= 0) due.push(s);
        else remaining.push(s);
      }
    }
    this.pendingStrikes = remaining;
    if (!due.length) return false;

    for (const strike of due) {
      if (this.mode === 'online' && this.isHost) {
        this.cb.onOnlineAction?.({
          type: 'strike_drop',
          strike,
          rngState: this.rng.getState(),
        });
      }
      spawnAirStrikeBombs(this, strike);
    }
    this.showToast('AIR STRIKE IMPACT!', '#dc2626', 45);
    return true;
  }

  triggerTest() {
    for (const tank of this.tanks) {
      tank.playing = false;
      tank.testing = true;
      tank.naZemi = false;
    }
    this.testing = true;
  }

  // Advance to the next alive player in ascending score order (lowest -> highest)
  nextPlayer() {
    if (this.aliveCount <= 1 || !this.turnOrder.length) return;
    let safety = 0;
    const total = this.turnOrder.length;
    while (safety++ < total + 2) {
      const cand = this.turnOrder[this.turnIdx % total];
      this.turnIdx = (this.turnIdx + 1) % total;
      this.activeTank = cand;
      this.nextTank = this.turnOrder[this.turnIdx % total];
      this.activeTank.playing = true;
      if (this.activeTank.data.live && this.activeTank.data.energy > 0) break;
      this.activeTank.playing = false;
    }

    const prevMult = this.getDamageMultiplier();
    this.roundTurns += 1;
    const newMult = this.getDamageMultiplier();
    if (newMult > prevMult) {
      this.showToast(`SUDDEN DEATH! ${newMult.toFixed(1)}× DAMAGE`, '#ea580c', 70);
    }

    this.turnTicksLeft = this.turnTimerSec > 0 ? this.turnTimerSec * FPS : 0;

    if (this.aliveCount > 1 && this.activeTank && this.activeTank.data.live) {
      this.blik = {
        x: this.activeTank.x,
        y: this.activeTank.y,
        frame: 0,
        col: hexIntToCss(this.activeTank.data.col),
      };
    }
    this.terrain.updateWind(this.rng);
    this.sound.stop(SOUNDS.TURRET_MOVE);
    this.activeTank.onTurnStart();
    this.shieldsMenuOpen = false;
    this.shotFlying = false;
    this._notifyStatus();

    // Auto-save cleanly at the start of every turn (Local or Online Host)
    if (this.mode === 'local' || this.isHost) {
      this.cb.onAutoSave?.(this.buildSaveData('Auto-Save'));
    }

    // In online mode, host broadcasts an authoritative turn-start snapshot so all peers stay 100% synced
    if (this.mode === 'online' && this.isHost) {
      this.cb.onOnlineAction?.({
        type: 'state_sync',
        ...this.buildSyncSnapshot(),
      });
    }
  }

  canLocalControl() {
    if (this.scene !== 'battle' || !this.activeTank || !this.activeTank.playing) return false;
    if (this.activeTank.type !== 'tank') return false;
    if (this.airStrike || this.teleport) return false;
    if (this.mode === 'online') {
      return this.activeTank.tankNumber === this.mySlot;
    }
    return true;
  }

  canLocalControlSpecialOverlay() {
    if (this.scene !== 'battle' || !this.activeTank) return false;
    if (this.mode === 'online') {
      return this.activeTank.tankNumber === this.mySlot;
    }
    return this.activeTank.type === 'tank';
  }

  // ==================== HTML HUD CONTROL BRIDGE ====================

  setAngle(deg) {
    if (!this.canLocalControl()) return;
    const t = this.activeTank;
    const clamped = Math.max(0, Math.min(180, Math.round(Number(deg) || 0)));
    if (clamped !== t.rotace) {
      t.rotace = clamped;
    }
  }

  setPower(val) {
    if (!this.canLocalControl()) return;
    const t = this.activeTank;
    const maxPow = getMaxPower(t.data.energy);
    const clamped = Math.max(0, Math.min(maxPow, Math.round(Number(val) || 0)));
    t.power = clamped;
  }

  setFuelMove(dir) {
    this.holdingFuelLeft = dir < 0;
    this.holdingFuelRight = dir > 0;
  }

  // ==================== ACTIONS (LOCAL + NETWORK SYNC) ====================

  _canAct(fromRemote, fromAI) {
    if (fromRemote) return true;
    if (fromAI) return this.mode === 'local' || this.isHost;
    return this.canLocalControl();
  }

  selectWeapon(gunIdx, fromRemote = false, fromAI = false) {
    if (!this._canAct(fromRemote, fromAI)) return;
    const t = this.activeTank;
    if (!t) return;
    if (gunIdx < 0 || gunIdx >= WEAPONS.length) return;
    if (!fromRemote && gunIdx !== 0 && t.data.guns[gunIdx] <= 0) return;
    if (t.data.cur_gun === gunIdx) return;
    t.data.cur_gun = gunIdx;
    if (!fromAI) this.sound.play(SOUNDS.UI_CLICK, { volume: 0.7 });
    if (!fromRemote && this.mode === 'online') {
      this.cb.onOnlineAction?.({ type: 'weapon', tankNumber: t.tankNumber, gun: t.data.cur_gun });
    }
  }

  cycleWeapon(dir, fromRemote = false) {
    if (!fromRemote && !this.canLocalControl()) return;
    const t = this.activeTank;
    if (!t) return;
    const guns = t.data.guns;
    const n = WEAPONS.length;
    const idx = t.data.cur_gun;
    for (let step = 1; step <= n; step++) {
      const cand = (idx + dir * step + n) % n;
      if (guns[cand] > 0) {
        t.data.cur_gun = cand;
        break;
      }
    }
    this.sound.play(SOUNDS.UI_CLICK, { volume: 0.7 });
    if (!fromRemote && this.mode === 'online') {
      this.cb.onOnlineAction?.({ type: 'weapon', tankNumber: t.tankNumber, gun: t.data.cur_gun });
    }
  }

  useRepair(fromRemote = false, fromAI = false, targetTank = null) {
    if (!this._canAct(fromRemote, fromAI)) return;
    const t = targetTank || this.activeTank;
    if (!t || (!fromRemote && (t.data.specials[1] <= 0 || t.data.energy >= t.data.max_energy))) return;
    const before = Math.round(t.data.energy);
    t.data.energy = Math.min(t.data.max_energy, before + REPAIR_HEAL_AMOUNT);
    const healed = Math.round(t.data.energy) - before;
    t.data.specials[1] = Math.max(0, t.data.specials[1] - 1);
    if (healed > 0) {
      this.vfx.spawnPopup(t.x, t.y - 8, `+${healed} HP`, '#16a34a');
    }
    this.sound.play(SOUNDS.UI_CLICK, { volume: 0.7 });
    if (!fromRemote && this.mode === 'online') {
      this.cb.onOnlineAction?.({
        type: 'repair',
        tankNumber: t.tankNumber,
        energy: t.data.energy,
        repairsLeft: t.data.specials[1],
      });
    }
  }

  toggleParachute(fromRemote = false, fromAI = false, targetTank = null) {
    if (!this._canAct(fromRemote, fromAI)) return;
    const t = targetTank || this.activeTank;
    if (!t || (!fromRemote && t.data.specials[0] <= 0)) return;
    t.par = !t.par;
    if (!fromAI) this.sound.play(SOUNDS.UI_CLICK, { volume: 0.7 });
    if (!fromRemote && this.mode === 'online') {
      this.cb.onOnlineAction?.({ type: 'parachute', tankNumber: t.tankNumber, enabled: t.par });
    }
  }

  beginTeleport(fromRemote = false, fromAI = false, targetTank = null) {
    if (!this._canAct(fromRemote, fromAI)) return;
    const t = targetTank || this.activeTank;
    if (!t || (!fromRemote && t.data.specials[7] <= 0)) return;
    t.data.specials[7] = Math.max(0, t.data.specials[7] - 1);
    t.playing = false;
    this.teleport = new TeleportController(t);
    this.teleport.cursorX = fromAI ? t.x : this.mouseX;
    this.teleport.cursorY = fromAI ? t.y : this.mouseY;
    this.cursorHidden = !fromRemote && !fromAI;
    this.shieldsMenuOpen = false;
    if (!fromRemote && this.mode === 'online') {
      this.cb.onOnlineAction?.({ type: 'teleport_begin', tankNumber: t.tankNumber });
    }
  }

  confirmTeleport(x, y, fromRemote = false) {
    if (!this.teleport || this.teleport.picked) return;
    const ownerNum = this.teleport.tank?.tankNumber || 0;
    this.teleport.confirm(x, y);
    this.cursorHidden = false;
    if (!fromRemote && this.mode === 'online') {
      this.cb.onOnlineAction?.({
        type: 'teleport_confirm',
        tankNumber: ownerNum,
        x: this.teleport.tarX,
        y: this.teleport.tarY,
        rngState: this.rng.getState(),
      });
    }
  }

  activateShield(tier, fromRemote = false, fromAI = false, targetTank = null) {
    if (!this._canAct(fromRemote, fromAI)) return;
    const t = targetTank || this.activeTank;
    if (!t) return;
    if (fromRemote && t.shActive) t.disableShield();
    if (t.activateShield(tier, fromRemote)) {
      this.shieldsMenuOpen = false;
      this.sound.play(SOUNDS.UI_CLICK, { volume: 0.7 });
      if (!fromRemote && this.mode === 'online') {
        this.cb.onOnlineAction?.({ type: 'shield_on', tankNumber: t.tankNumber, tier });
      }
    }
  }

  disableShield(fromRemote = false, fromAI = false, targetTank = null) {
    if (!this._canAct(fromRemote, fromAI)) return;
    const t = targetTank || this.activeTank;
    if (!t || !t.shActive) return;
    t.disableShield();
    this.shieldsMenuOpen = false;
    this.sound.play(SOUNDS.UI_CLICK, { volume: 0.7 });
    if (!fromRemote && this.mode === 'online') {
      this.cb.onOnlineAction?.({ type: 'shield_off', tankNumber: t.tankNumber });
    }
  }

  fireCurrentTank(fromRemote = false) {
    const t = this.activeTank;
    if (!t || !t.playing) return;
    if (!fromRemote && this.mode === 'online' && t.type === 'tank' && t.tankNumber !== this.mySlot) return;

    const gunIdx = t.data.cur_gun;
    const spec = getWeaponSpec(gunIdx);

    if (!fromRemote && this.mode === 'online') {
      this.cb.onOnlineAction?.({
        type: 'fire',
        tankNumber: t.tankNumber,
        x: t.x,
        y: t.y,
        rotace: t.rotace,
        power: t.power,
        fuel: t.data.fuel,
        gun: gunIdx,
        vitr: this.terrain.vitr,
        rngState: this.rng.getState(),
      });
    }

    if (gunIdx !== 0) {
      t.data.guns[gunIdx] = Math.max(0, t.data.guns[gunIdx] - 1);
      if (t.data.guns[gunIdx] === 0) {
        t.data.cur_gun = 0;
      }
    }

    t.playing = false;
    t.testing = true;
    this.shieldsMenuOpen = false;
    this.shotFlying = true;
    this.keys.fire = false;
    this.holdingFuelLeft = false;
    this.holdingFuelRight = false;
    this.sound.stop(SOUNDS.TURRET_MOVE);

    if (spec.kind === 'astrike') {
      t.barrelFrame = 0;
      t.barrelPlaying = false;
      this.airStrike = new AirStrikeController(t);
      this.airStrike.cursorX = this.mouseX;
      this.airStrike.cursorY = this.mouseY;
      this.cursorHidden = !fromRemote && this.canLocalControlSpecialOverlay();
      return;
    }

    t.barrelFrame = 1;
    t.barrelPlaying = true;
    this.sound.play(SOUNDS.MEDIUM_EXPLODE, { volume: 0.35, minIntervalMs: 40 });

    const proj = new Projectile({
      spec,
      owner: t,
      x: t.x,
      y: t.y - 1,
      parentRot: t.rotace - 90,
      vo: t.power,
    });
    this.projectiles.push(proj);
  }

  launchAirStrike(targetX, uhel, fromRemote = false) {
    if (!this.airStrike || this.airStrike.launched) return;
    const ownerNum = this.airStrike.owner?.tankNumber || 0;
    if (uhel !== undefined) this.airStrike.uhel = uhel;
    this.airStrike.launch(this, targetX);
    const last = this.pendingStrikes[this.pendingStrikes.length - 1];
    if (last) last.justPlanted = true;
    this.cursorHidden = false;
    if (!fromRemote && this.mode === 'online') {
      this.cb.onOnlineAction?.({
        type: 'astrike_launch',
        tankNumber: ownerNum,
        x: targetX,
        uhel: this.airStrike.uhel,
        rngState: this.rng.getState(),
      });
    }
  }

  // ==================== SERIALIZATION, SAVE/LOAD & ONLINE SYNC ====================

  _serializePlayerData() {
    return this.playerData.map((pd) => ({
      t_num: pd.t_num,
      name: pd.name,
      col: pd.col,
      type: pd.type,
      dif: pd.dif,
      guns: pd.guns.slice(),
      specials: pd.specials.slice(),
      cur_gun: pd.cur_gun,
      energy: pd.energy,
      max_energy: pd.max_energy,
      fuel: pd.fuel,
      score: pd.score,
      total_score: pd.total_score,
      live: pd.live,
      kills: pd.kills,
    }));
  }

  _applySerializedPlayerData(arr) {
    if (!Array.isArray(arr) || !arr.length) return;
    if (this.playerData.length !== arr.length) {
      this.playerCount = arr.length;
      this.playerData = arr.map((src, idx) =>
        createInitialTankData(
          src.t_num || idx + 1,
          src.name || `Player ${idx + 1}`,
          src.col ?? PLAYER_COLORS[idx % PLAYER_COLORS.length],
          src.type || 'tank',
          src.dif || 'normal',
          this.balancePreset
        )
      );
    }
    for (let i = 0; i < Math.min(arr.length, this.playerData.length); i++) {
      const src = arr[i];
      const dst = this.playerData[i];
      if (src.name) dst.name = src.name;
      if (src.col !== undefined) dst.col = src.col;
      dst.type = src.type;
      dst.dif = src.dif;
      dst.guns = src.guns.slice();
      dst.specials = src.specials.slice();
      dst.cur_gun = src.cur_gun;
      dst.energy = src.energy;
      dst.max_energy = src.max_energy;
      dst.fuel = src.fuel;
      dst.score = src.score;
      dst.total_score = src.total_score;
      dst.live = src.live;
      dst.kills = src.kills;
    }
  }

  _serializeTanks() {
    return this.tanks.map((t) => ({
      tankNumber: t.tankNumber,
      x: t.x,
      y: t.y,
      rotace: t.rotace,
      power: t.power,
      par: t.par,
      shActive: t.shActive,
      shieldUsedThisRound: t.shieldUsedThisRound,
      shieldTier: t.shieldTier,
      shieldEnergy: t.shieldEnergy,
      shieldMax: t.shieldMax,
      shieldSprite: t.shieldSprite,
      dead: t.dead,
      dying: t.dying,
      playing: t.playing,
      visible: t.visible,
    }));
  }

  buildSyncSnapshot() {
    return {
      round: this.gameRound,
      scene: this.scene,
      krajinaSetting: this.krajinaSetting,
      balancePreset: this.balancePreset,
      turnTimerSec: this.turnTimerSec,
      turnTicksLeft: this.turnTicksLeft,
      roundTurns: this.roundTurns,
      fastForward: this.fastForward,
      vitr: this.terrain.vitr,
      rngState: this.rng.getState(),
      turnOrder: this.turnOrder.map((t) => t.tankNumber),
      turnIdx: this.turnIdx,
      activeSlot: this.activeTank ? this.activeTank.tankNumber : 0,
      aliveCount: this.aliveCount,
      pendingStrikes: this.pendingStrikes.map((s) => ({ ...s })),
      terrain: this.scene === 'battle' ? this.terrain.serialize() : null,
      playerData: this._serializePlayerData(),
      tanks: this._serializeTanks(),
    };
  }

  canSaveGame() {
    if (this.scene !== 'battle' && this.scene !== 'shop') return false;
    if (this.scene === 'battle' && (this._hasActiveBattleVisuals() || this.testing || this.roundEndPending)) {
      return false;
    }
    return this.playerData.length >= 2;
  }

  buildSaveData(label = '') {
    const names = this.playerData.map((p) => p.name).join(', ');
    return {
      version: 1,
      id: `save-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      savedAt: Date.now(),
      label: (label || '').trim() || `Round ${this.gameRound} · ${names}`,
      mode: this.mode,
      krajinaSetting: this.krajinaSetting,
      balancePreset: this.balancePreset,
      turnTimerSec: this.turnTimerSec,
      turnTicksLeft: this.turnTicksLeft,
      gameRound: this.gameRound,
      roundTurns: this.roundTurns,
      scene: this.scene === 'shop' ? 'shop' : 'battle',
      shopCur: this.shopCur,
      rngState: this.rng.getState(),
      aiRngState: this.aiRng.getState(),
      turnOrder: this.turnOrder.map((t) => t.tankNumber),
      turnIdx: this.turnIdx,
      activeSlot: this.activeTank ? this.activeTank.tankNumber : 0,
      aliveCount: this.aliveCount,
      pendingStrikes: this.pendingStrikes.map((s) => ({ ...s })),
      terrain: this.scene === 'battle' ? this.terrain.serialize() : null,
      playerData: this._serializePlayerData(),
      tanks: this._serializeTanks(),
    };
  }

  loadSaveData(save, opts = {}) {
    if (!save || !Array.isArray(save.playerData) || save.playerData.length < 2) {
      throw new Error('Invalid or corrupted save file.');
    }

    const mode = opts.mode || 'local';
    this.mode = mode;
    this.mySlot = mode === 'online' ? (opts.mySlot || 1) : 0;
    this.isHost = mode === 'online' ? Boolean(opts.isHost) : true;
    this.onlineReadySent = false;
    this.onlineReadyStatus = '';
    this._pendingStateSync = null;
    this._pendingStateSyncWait = 0;

    this.krajinaSetting = Number(save.krajinaSetting ?? 0);
    this.randKrajina = this.krajinaSetting === 0;
    this.setBalancePreset(save.balancePreset || 'balanced');
    this.setTurnTimer(opts.turnTimerSec !== undefined ? opts.turnTimerSec : (save.turnTimerSec ?? 0));
    this.gameRound = Math.max(1, Number(save.gameRound || 1));
    this.roundTurns = Math.max(0, Number(save.roundTurns || 0));
    this.turnTicksLeft = this.turnTimerSec > 0
      ? Math.max(FPS * 3, Number(save.turnTicksLeft || this.turnTimerSec * FPS))
      : 0;
    this.playerCount = save.playerData.length;

    if (save.rngState !== undefined) this.rng.setState(save.rngState);
    if (save.aiRngState !== undefined) this.aiRng.setState(save.aiRngState);

    const overrides = Array.isArray(opts.slotOverrides) ? opts.slotOverrides : null;
    this.playerData = save.playerData.map((src, idx) => {
      const ov = overrides?.[idx];
      const base = createInitialTankData(
        idx + 1,
        ov?.name || src.name || `Player ${idx + 1}`,
        ov?.col ?? src.col ?? PLAYER_COLORS[idx % PLAYER_COLORS.length],
        ov?.type || src.type || 'tank',
        ov?.dif || src.dif || 'normal',
        this.balancePreset
      );
      base.guns = Array.isArray(src.guns) ? src.guns.slice(0, WEAPONS.length) : base.guns;
      while (base.guns.length < WEAPONS.length) base.guns.push(0);
      base.specials = Array.isArray(src.specials) ? src.specials.slice(0, SPECIALS.length) : base.specials;
      while (base.specials.length < SPECIALS.length) base.specials.push(0);
      base.cur_gun = Number(src.cur_gun || 0);
      base.energy = Number(src.energy ?? base.energy);
      base.max_energy = Number(src.max_energy ?? 100 + Math.min(MAX_UPGRADE_LEVEL, base.specials[8] || 0) * 10);
      base.fuel = Number(src.fuel ?? base.specials[2]);
      base.score = Math.max(0, Number(src.score ?? 0));
      base.total_score = Math.max(0, Number(src.total_score ?? 0));
      base.live = src.live !== false;
      base.kills = Number(src.kills || 0);
      return base;
    });

    this.vfx.clearBattleFx();
    this.projectiles = [];
    this.airStrike = null;
    this.teleport = null;
    this._aiPendingAirStrike = null;
    this._aiPendingTeleport = null;
    this.blik = null;
    this.shieldsMenuOpen = false;
    this.draggingAngle = false;
    this.holdingFuelLeft = false;
    this.holdingFuelRight = false;
    this.testing = false;
    this.shotFlying = false;
    this.roundEndPending = false;
    this.roundTransitioning = false;
    this._roundPayoutAwarded = false;
    this.fastForward = false;
    this.cursorHidden = false;
    this.pendingStrikes = Array.isArray(save.pendingStrikes)
      ? save.pendingStrikes.map((s) => ({ ...s }))
      : [];

    if (save.scene === 'shop' || !save.terrain) {
      this.tanks = [];
      this.scene = 'shop';
      this._initTitlePanorama(this.krajinaSetting === 0 ? 1 : this.krajinaSetting);
      if (this.mode === 'online') {
        this.shopCur = this.mySlot;
      } else {
        const savedCur = Math.max(1, Math.min(this.playerCount, Number(save.shopCur || 1)));
        this.shopCur = savedCur;
        if (this.playerData[this.shopCur - 1]?.type !== 'tank') {
          this.shopCur = 0;
          this._shopNextPlayer();
        }
      }
      this.showToast(`Loaded Save (Round ${this.gameRound} Shop)`, '#16a34a', 65);
      this._notifyStatus();
      return;
    }

    this.scene = 'battle';
    this.terrain.deserialize(save.terrain);

    this.tanks = this.playerData.map((pd, idx) => {
      const s = save.tanks?.[idx];
      const tk = new Tank(pd, s ? s.x : 80 + idx * 85, this.terrain, this.rng, false);
      if (s) {
        tk.x = s.x;
        tk.y = s.y;
        tk.rotace = s.rotace;
        tk.power = s.power;
        tk.par = Boolean(s.par);
        tk.shActive = Boolean(s.shActive);
        tk.shieldUsedThisRound = Boolean(s.shieldUsedThisRound);
        tk.shieldTier = s.shieldTier || 0;
        tk.shieldEnergy = s.shieldEnergy || 0;
        tk.shieldMax = s.shieldMax || 0;
        tk.shieldSprite = s.shieldSprite || null;
        tk.dead = Boolean(s.dead);
        tk.dying = Boolean(s.dying);
        tk.playing = Boolean(s.playing);
        tk.visible = s.visible !== false;
        tk.testing = false;
        tk.fall = 0;
        tk.fallStartY = null;
        tk.parOut = false;
      }
      return tk;
    });

    if (Array.isArray(save.turnOrder) && save.turnOrder.length) {
      this.turnOrder = save.turnOrder.map((num) => this.tanks[num - 1]).filter(Boolean);
    } else {
      this.turnOrder = [...this.tanks];
    }
    this.turnIdx = Number(save.turnIdx || 0) % Math.max(1, this.turnOrder.length);
    this.aliveCount = this.tanks.filter((t) => t.data.live && !t.dead).length;
    this.activeTank = save.activeSlot > 0 ? (this.tanks[save.activeSlot - 1] || null) : null;
    if (!this.activeTank || !this.activeTank.data.live) {
      this.activeTank = this.tanks.find((t) => t.data.live && !t.dead) || null;
    }
    for (const tk of this.tanks) tk.playing = tk === this.activeTank;
    if (this.activeTank) {
      this.activeTank.firstFrame = true;
      this.activeTank._aiTurnFrames = 0;
      this.blik = {
        x: this.activeTank.x,
        y: this.activeTank.y,
        frame: 0,
        col: hexIntToCss(this.activeTank.data.col),
      };
    }
    this.nextTank = this.turnOrder.length ? this.turnOrder[this.turnIdx % this.turnOrder.length] : null;
    this.showToast(`Loaded Save (Round ${this.gameRound})`, '#16a34a', 65);
    this._notifyStatus();
  }

  applyStateSync(snap) {
    if (!snap || this.mode !== 'online') return;
    this._pendingStateSync = null;
    this._pendingStateSyncWait = 0;

    if (snap.round !== undefined) this.gameRound = snap.round;
    if (snap.krajinaSetting !== undefined) {
      this.krajinaSetting = snap.krajinaSetting;
      this.randKrajina = this.krajinaSetting === 0;
    }
    if (snap.balancePreset) this.setBalancePreset(snap.balancePreset);
    if (snap.turnTimerSec !== undefined) this.setTurnTimer(snap.turnTimerSec);
    if (snap.turnTicksLeft !== undefined) this.turnTicksLeft = snap.turnTicksLeft;
    if (snap.roundTurns !== undefined) this.roundTurns = snap.roundTurns;
    if (snap.fastForward !== undefined) this.fastForward = Boolean(snap.fastForward);
    if (Array.isArray(snap.pendingStrikes)) {
      this.pendingStrikes = snap.pendingStrikes.map((s) => ({ ...s }));
    }
    if (snap.rngState !== undefined) this.rng.setState(snap.rngState);
    if (snap.playerData) this._applySerializedPlayerData(snap.playerData);

    if (snap.scene === 'shop') {
      if (this.scene !== 'shop') {
        this._openShop(true);
      }
      if (snap.forceImmediate) {
        this.showToast('Synced with host!', '#16a34a', 50);
      }
      this._notifyStatus();
      return;
    }

    if (snap.scene !== 'battle') return;

    if (this.scene !== 'battle') {
      this.scene = 'battle';
    }
    if (snap.terrain) {
      this.terrain.deserialize(snap.terrain);
    }
    if (snap.vitr !== undefined) {
      this.terrain.vitr = snap.vitr;
    }

    if (this.tanks.length !== this.playerData.length) {
      this.tanks = this.playerData.map((pd, idx) => {
        const s = snap.tanks?.[idx];
        return new Tank(pd, s ? s.x : 100 + idx * 80, this.terrain, this.rng, false);
      });
    }

    const prevActiveNum = this.activeTank ? this.activeTank.tankNumber : 0;

    if (Array.isArray(snap.tanks)) {
      for (let i = 0; i < Math.min(snap.tanks.length, this.tanks.length); i++) {
        const s = snap.tanks[i];
        const tk = this.tanks[i];
        tk.type = tk.data.type;
        tk.dif = tk.data.dif;
        tk.x = s.x;
        tk.y = s.y;
        tk.rotace = s.rotace;
        tk.power = s.power;
        tk.par = s.par;
        tk.shActive = s.shActive;
        tk.shieldUsedThisRound = Boolean(s.shieldUsedThisRound);
        tk.shieldTier = s.shieldTier;
        tk.shieldEnergy = s.shieldEnergy;
        tk.shieldMax = s.shieldMax;
        tk.shieldSprite = s.shieldSprite;
        tk.dead = s.dead;
        tk.dying = s.dying;
        tk.playing = s.playing;
        tk.visible = s.visible !== false;
        tk.testing = false;
        tk.fall = 0;
        tk.fallStartY = null;
        tk.parOut = false;
        tk.barrelFrame = 0;
        tk.barrelPlaying = false;
      }
    }

    if (Array.isArray(snap.turnOrder) && snap.turnOrder.length) {
      this.turnOrder = snap.turnOrder
        .map((num) => this.tanks[num - 1])
        .filter(Boolean);
    }
    if (snap.turnIdx !== undefined) this.turnIdx = snap.turnIdx;
    if (snap.aliveCount !== undefined) this.aliveCount = snap.aliveCount;

    this.activeTank = snap.activeSlot > 0 ? this.tanks[snap.activeSlot - 1] || null : null;
    this.nextTank = this.turnOrder.length ? this.turnOrder[this.turnIdx % this.turnOrder.length] : null;
    this.projectiles = [];
    this.airStrike = null;
    this.teleport = null;
    this._aiPendingAirStrike = null;
    this._aiPendingTeleport = null;
    this.testing = false;
    this.shotFlying = false;
    this.roundEndPending = false;
    this.roundTransitioning = false;
    this.shieldsMenuOpen = false;
    this.sound.stop(SOUNDS.TURRET_MOVE);

    if (this.activeTank && this.activeTank.data.live && this.activeTank.tankNumber !== prevActiveNum) {
      this.blik = {
        x: this.activeTank.x,
        y: this.activeTank.y,
        frame: 0,
        col: hexIntToCss(this.activeTank.data.col),
      };
      this.activeTank.onTurnStart();
    }
    if (snap.forceImmediate) {
      this.showToast('Synced with host!', '#16a34a', 50);
    }
    this._notifyStatus();
  }

  _hasActiveBattleVisuals() {
    return Boolean(
      this.projectiles.length ||
      this.airStrike ||
      this.teleport ||
      this.tanks.some((t) => t.dying)
    );
  }

  _catchUpForRemote(expectedTankNumber = 0) {
    if (this._pendingStateSync) {
      this.applyStateSync(this._pendingStateSync);
    }
    let guard = 0;
    while (this.scene === 'loading' && guard < 180) {
      this.tick();
      guard++;
    }
    if (expectedTankNumber > 0 && this.scene === 'battle') {
      guard = 0;
      while (
        guard < 250 &&
        this.activeTank &&
        this.activeTank.tankNumber !== expectedTankNumber &&
        (this.testing || this.projectiles.length || this.airStrike || this.teleport || this.tanks.some((t) => t.dying))
      ) {
        this.tick();
        guard++;
      }
    }
  }

  applyRemoteAim(msg) {
    if (this.scene === 'loading') return;
    if (this.scene !== 'battle' || !this.activeTank) return;
    if (this.activeTank.tankNumber !== msg.tankNumber) return;
    this.activeTank.x = msg.x;
    this.activeTank.y = msg.y;
    this.activeTank.rotace = msg.rotace;
    this.activeTank.power = msg.power;
    this.activeTank.data.fuel = msg.fuel;
    if (msg.gun !== undefined) this.activeTank.data.cur_gun = msg.gun;
  }

  applyRemoteAction(msg) {
    if (!msg) return;

    if (msg.type === 'state_sync') {
      if (this.scene === 'battle' && this._hasActiveBattleVisuals() && !msg.forceImmediate) {
        this._pendingStateSync = msg;
        this._pendingStateSyncWait = 0;
      } else {
        this.applyStateSync(msg);
      }
      return;
    }

    if (msg.type === 'open_shop') {
      if (msg.playerData) this._applySerializedPlayerData(msg.playerData);
      if (this.scene !== 'shop') {
        this.roundEndPending = false;
        this._pendingStateSync = null;
        this._openShop(false);
      }
      return;
    }

    if (msg.type === 'shop_buy') {
      this.applyShopPurchase(msg.slot, msg.kind, msg.index, true);
      return;
    }

    if (msg.type === 'fast_forward') {
      this.setFastForward(Boolean(msg.enabled), true);
      return;
    }

    if (msg.type === 'strike_drop') {
      this._catchUpForRemote(0);
      if (this.scene === 'battle' && msg.strike) {
        if (msg.rngState !== undefined) this.rng.setState(msg.rngState);
        const idx = this.pendingStrikes.findIndex(
          (s) => s.targetX === msg.strike.targetX && s.ownerNum === msg.strike.ownerNum
        );
        if (idx >= 0) this.pendingStrikes.splice(idx, 1);
        spawnAirStrikeBombs(this, msg.strike);
        this.showToast('AIR STRIKE IMPACT!', '#dc2626', 45);
      }
      return;
    }

    this._catchUpForRemote(msg.tankNumber || 0);
    if (this.scene !== 'battle') return;

    const targetTank = msg.tankNumber > 0 ? this.tanks[msg.tankNumber - 1] : this.activeTank;
    if (!targetTank) return;

    switch (msg.type) {
      case 'weapon':
        targetTank.data.cur_gun = msg.gun;
        break;
      case 'repair':
        if (msg.energy !== undefined) {
          targetTank.data.energy = msg.energy;
          if (msg.repairsLeft !== undefined) targetTank.data.specials[1] = msg.repairsLeft;
          this.sound.play(SOUNDS.UI_CLICK, { volume: 0.7 });
        } else {
          this.useRepair(true, false, targetTank);
        }
        break;
      case 'parachute':
        targetTank.par = Boolean(msg.enabled);
        break;
      case 'shield_on':
        this.activateShield(msg.tier, true, false, targetTank);
        break;
      case 'shield_off':
        this.disableShield(true, false, targetTank);
        break;
      case 'teleport_begin':
        this.beginTeleport(true, false, targetTank);
        break;
      case 'teleport_confirm':
        if (!this.teleport) this.beginTeleport(true, false, targetTank);
        if (msg.rngState !== undefined) this.rng.setState(msg.rngState);
        this.confirmTeleport(msg.x, msg.y, true);
        break;
      case 'astrike_launch':
        if (!this.airStrike) {
          this.airStrike = new AirStrikeController(targetTank);
        }
        if (msg.rngState !== undefined) this.rng.setState(msg.rngState);
        this.launchAirStrike(msg.x, msg.uhel, true);
        break;
      case 'fire':
        for (const tk of this.tanks) tk.playing = false;
        this.activeTank = targetTank;
        targetTank.playing = true;
        targetTank.x = msg.x;
        targetTank.y = msg.y;
        targetTank.rotace = msg.rotace;
        targetTank.power = msg.power;
        targetTank.data.fuel = msg.fuel;
        targetTank.data.cur_gun = msg.gun;
        if (msg.vitr !== undefined) this.terrain.vitr = msg.vitr;
        if (msg.rngState !== undefined) this.rng.setState(msg.rngState);
        this.fireCurrentTank(true);
        break;
    }
  }

  // ==================== ARMORY SHOP ====================

  _openShop(fromSync = false) {
    this.scene = 'shop';
    this.roundEndPending = false;
    this.roundTransitioning = false;
    this.tanks = [];
    this.projectiles = [];
    this.airStrike = null;
    this.teleport = null;
    this.pendingStrikes = [];
    this.fastForward = false;
    this.blik = null;
    this.shieldsMenuOpen = false;
    this.cursorHidden = false;
    this.clearKeys();

    // Ensure a lush Paper-Cut landscape is visible behind the frosted Shop overlay
    if (!this.terrain.cols[0]) {
      this._initTitlePanorama(this.krajinaSetting === 0 ? 1 : this.krajinaSetting);
    } else {
      this.terrain.vitr = 10;
    }

    if (this.mode === 'online') {
      this.shopCur = this.mySlot;
      this.onlineReadySent = false;
      this.onlineReadyStatus = '';
      if (this.isHost && !fromSync) {
        for (let slot = 1; slot <= this.playerCount; slot++) {
          if (this.playerData[slot - 1].type === 'ai') {
            aiBuyInShop(slot, this);
          }
        }
        this.cb.onAutoSave?.(this.buildSaveData('Auto-Save (Shop)'));
      }
    } else {
      this.shopCur = 0;
      this._shopNextPlayer();
      if (this.scene === 'shop') {
        this.cb.onAutoSave?.(this.buildSaveData('Auto-Save (Shop)'));
      }
    }
    this._notifyStatus();
  }

  shopNext() {
    this._shopNextPlayer();
  }

  _shopNextPlayer() {
    if (this.mode === 'online') {
      if (!this.onlineReadySent) {
        this.onlineReadySent = true;
        this.sound.play(SOUNDS.UI_CLICK, { volume: 0.8 });
        this.cb.onOnlineShopReady?.();
      }
      return;
    }

    while (this.shopCur < this.playerCount) {
      this.shopCur += 1;
      if (this.playerData[this.shopCur - 1].type === 'tank') {
        this._notifyStatus();
        return;
      }
      aiBuyInShop(this.shopCur, this);
    }

    // All players finished shopping -> jump cleanly into next round!
    this.sound.play(SOUNDS.UI_CLICK, { volume: 0.8 });
    this._startNextRound();
  }

  getShopButtonCaption() {
    return this._shopButtonCaption();
  }

  _shopButtonCaption() {
    if (this.mode === 'online') {
      return this.onlineReadySent ? (this.onlineReadyStatus || 'Waiting...') : 'Ready for Next Round';
    }
    for (let i = this.shopCur + 1; i <= this.playerCount; i++) {
      if (this.playerData[i - 1].type === 'tank') return 'Next Player →';
    }
    return 'Start Next Round →';
  }

  applyShopPurchase(slot, kind, index, fromRemote = false, silent = false) {
    const pd = this.playerData[slot - 1];
    if (!pd) return false;
    if (kind === 'weapon') {
      const w = WEAPONS[index];
      if (!w || w.price <= 0 || (!fromRemote && pd.score < w.price)) return false;
      pd.guns[index] += w.pack;
      pd.score = Math.max(0, pd.score - w.price);
    } else {
      const s = SPECIALS[index];
      if (!s) return false;
      if (!fromRemote && s.maxLevel && pd.specials[index] >= s.maxLevel) return false;
      if (!fromRemote && pd.score < s.price) return false;
      pd.specials[index] = s.maxLevel
        ? Math.min(s.maxLevel, pd.specials[index] + s.pack)
        : pd.specials[index] + s.pack;
      pd.score = Math.max(0, pd.score - s.price);
    }
    if (!fromRemote) {
      if (!silent) this.sound.play(SOUNDS.UI_CLICK, { volume: 0.7 });
      if (this.mode === 'online') {
        this.cb.onOnlineShopBuy?.({ slot, kind, index });
      }
    }
    return true;
  }

  // ==================== 25Hz SIMULATION TICK ====================

  tick(viewBounds = null) {
    // Scenic drifting clouds & weather run across ALL scenes for a living Paper-Cut backdrop
    this.terrain.tick(viewBounds);
    this.vfx.tick(this.terrain.krajina, this.terrain.vitr, viewBounds);

    if (this.bannerToast && this.scene !== 'battle') {
      this.bannerToast.frames--;
      if (this.bannerToast.frames <= 0) this.bannerToast = null;
    }

    if (this.scene === 'loading') {
      const pct = this.terrain.stepGenerate(this.rng, 180);
      if (pct >= 100) {
        this._enterBattle();
      }
      return;
    }

    if (this.scene !== 'battle') return;

    if (this.fastForward && !this.isBotsOnlyAlive()) {
      this.fastForward = false;
    }

    // Turn indicator chevron (35 frames)
    if (this.blik) {
      this.blik.frame++;
      if (this.blik.frame >= 35) this.blik = null;
    }

    // Active Air Strike controller
    if (this._aiPendingAirStrike) {
      if (!this.airStrike || this.airStrike.launched) {
        this._aiPendingAirStrike = null;
      } else {
        this._aiPendingAirStrike.delay--;
        if (this._aiPendingAirStrike.delay <= 0) {
          const pending = this._aiPendingAirStrike;
          this._aiPendingAirStrike = null;
          this.launchAirStrike(pending.x, pending.uhel, false);
        }
      }
    }
    if (this.airStrike) {
      this.airStrike.tick(this);
      if (this.airStrike.done) this.airStrike = null;
    }

    // Active Teleport controller
    if (this._aiPendingTeleport) {
      if (!this.teleport || this.teleport.picked) {
        this._aiPendingTeleport = null;
      } else {
        this._aiPendingTeleport.delay--;
        if (this._aiPendingTeleport.delay <= 0) {
          const pending = this._aiPendingTeleport;
          this._aiPendingTeleport = null;
          this.confirmTeleport(pending.x, pending.y, false);
        }
      }
    }
    if (this.teleport) {
      this.teleport.tick(this);
      if (this.teleport.done) this.teleport = null;
    }

    // Tick all projectiles
    if (this.projectiles.length) {
      const snapshot = this.projectiles.slice();
      for (const proj of snapshot) {
        proj.tick(this);
      }
      this.projectiles = this.projectiles.filter((p) => !p.done);
    }

    // Tick AI controller if active tank is AI
    if (this.activeTank && this.activeTank.playing && this.activeTank.type === 'ai') {
      if (this.mode === 'local' || this.isHost) {
        try {
          tickAI(this.activeTank, this);
        } catch (err) {
          console.error('AI turn error, falling back to safe shot:', err);
          this.activeTank.firstFrame = true;
          this.activeTank.data.cur_gun = 0;
          this.fireCurrentTank();
        }
      }
    }

    // Build human input for active tank (keyboard + bottom-dock fuel hold buttons)
    const localCtrl = this.canLocalControl();
    const activeInput = localCtrl
      ? {
          left: this.keys.left || this.holdingFuelLeft,
          right: this.keys.right || this.holdingFuelRight,
          angleUp: this.keys.angleUp,
          angleDown: this.keys.angleDown,
          powerUp: this.keys.powerUp,
          powerDown: this.keys.powerDown,
          fire: this.keys.fire,
        }
      : null;

    // Tick all tanks
    for (const tank of this.tanks) {
      tank.tick(this, tank === this.activeTank ? activeInput : null);
    }

    // Sync live aiming / movement over network for local player OR host's AI
    if (this.mode === 'online' && this.activeTank && this.activeTank.playing) {
      const isMyTurn =
        (this.activeTank.type === 'tank' && this.activeTank.tankNumber === this.mySlot) ||
        (this.activeTank.type === 'ai' && this.isHost);
      if (isMyTurn) {
        this._aimSyncCounter++;
        if (this._aimSyncCounter >= 2) {
          this._aimSyncCounter = 0;
          const t = this.activeTank;
          const sig = `${Math.round(t.x * 10)},${Math.round(t.y * 10)},${Math.round(t.rotace * 2)},${Math.round(t.power * 2)},${t.data.cur_gun}`;
          if (sig !== this._lastSentAim) {
            this._lastSentAim = sig;
            this.cb.onOnlineAim?.({
              tankNumber: t.tankNumber,
              x: t.x,
              y: t.y,
              rotace: t.rotace,
              power: t.power,
              fuel: t.data.fuel,
              gun: t.data.cur_gun,
            });
          }
        }
      }
    }

    // Banner toast countdown
    if (this.bannerToast) {
      this.bannerToast.frames--;
      if (this.bannerToast.frames <= 0) this.bannerToast = null;
    }

    // Pulse pending Air Strike flares
    for (const s of this.pendingStrikes) {
      s.pulse = ((s.pulse || 0) + 1) % 30;
    }

    // Optional Turn Timer countdown
    if (
      this.turnTimerSec > 0 &&
      this.activeTank &&
      this.activeTank.type === 'tank' &&
      (this.activeTank.playing || (this.airStrike && !this.airStrike.launched) || (this.teleport && !this.teleport.picked))
    ) {
      if (this.turnTicksLeft > 0) {
        this.turnTicksLeft--;
      }
      if (this.turnTicksLeft <= 0 && (this.canLocalControl() || this.canLocalControlSpecialOverlay())) {
        if (this.airStrike && !this.airStrike.launched) {
          this.launchAirStrike(this.airStrike.cursorX, this.airStrike.uhel);
        } else if (this.teleport && !this.teleport.picked) {
          this.confirmTeleport(this.teleport.cursorX, this.teleport.cursorY);
        } else if (this.activeTank.playing) {
          this.showToast(`${this.activeTank.data.name} time up! Auto-firing...`, '#ea580c', 45);
          this.fireCurrentTank();
        }
      }
    }

    // Apply deferred authoritative host state_sync once current explosion/death visuals finish
    if (this._pendingStateSync) {
      this._pendingStateSyncWait++;
      if (!this._hasActiveBattleVisuals() || this._pendingStateSyncWait >= 20) {
        this.applyStateSync(this._pendingStateSync);
        return;
      }
    }

    // Settling & round-end check
    if (this.testing && !this.projectiles.length && !this.airStrike && !this.teleport) {
      let anyTesting = false;
      for (const tank of this.tanks) {
        if (tank.dying || (tank.testing && tank.data.live)) {
          anyTesting = true;
          break;
        }
      }
      if (!anyTesting) {
        this.testing = false;
        if (this.aliveCount > 1) {
          if (this.mode !== 'online' || this.isHost) {
            const droppedStrike = this._processPendingStrikes();
            if (!droppedStrike) {
              this.nextPlayer();
            }
          }
        }
      }
    }

    // Check round end (< 2 tanks alive and everything settled)
    if (
      (this.mode !== 'online' || this.isHost) &&
      this.aliveCount < 2 &&
      !this.roundEndPending &&
      !this.roundTransitioning &&
      !this.testing &&
      !this.projectiles.length &&
      !this.airStrike &&
      !this.teleport &&
      !this.tanks.some((t) => t.dying)
    ) {
      this._awardRoundEndPayouts();
      this.roundEndPending = true;
      this.roundEndTimer = 0;
    }

    if (this.roundEndPending) {
      this.roundEndTimer++;
      if (this.roundEndTimer >= 36) {
        this.roundEndPending = false;
        this.roundTransitioning = true;
        if (this.mode === 'online' && this.isHost) {
          this.cb.onOnlineAction?.({
            type: 'open_shop',
            playerData: this._serializePlayerData(),
          });
        }
        this._openShop(false);
      }
    }
  }

  // ==================== INPUT HANDLERS ====================

  handleKeyDown(e) {
    this.sound.unlock();
    const code = e.code;

    if (this.scene === 'shop' && code === 'Enter') {
      e.preventDefault();
      this._shopNextPlayer();
      return;
    }

    if (this.scene !== 'battle') return;

    // Air strike direction flip
    if (this.airStrike && !this.airStrike.launched && this.canLocalControlSpecialOverlay()) {
      if (code === 'ArrowLeft') {
        e.preventDefault();
        this.airStrike.setDirection('left');
        return;
      }
      if (code === 'ArrowRight') {
        e.preventDefault();
        this.airStrike.setDirection('right');
        return;
      }
    }

    if (!this.canLocalControl()) return;

    if (code === 'KeyQ') {
      e.preventDefault();
      this.cycleWeapon(-1);
      return;
    }
    if (code === 'KeyE') {
      e.preventDefault();
      this.cycleWeapon(1);
      return;
    }

    if (code === 'PageUp' || code === 'KeyW') {
      e.preventDefault();
      this.keys.powerUp = true;
    } else if (code === 'PageDown' || code === 'KeyS') {
      e.preventDefault();
      this.keys.powerDown = true;
    } else if (code === 'ArrowLeft') {
      e.preventDefault();
      this.keys.left = true;
    } else if (code === 'ArrowRight') {
      e.preventDefault();
      this.keys.right = true;
    } else if (code === 'ArrowUp') {
      e.preventDefault();
      this.keys.angleUp = true;
    } else if (code === 'ArrowDown') {
      e.preventDefault();
      this.keys.angleDown = true;
    } else if (code === 'Space') {
      e.preventDefault();
      this.keys.fire = true;
    }
  }

  handleKeyUp(e) {
    const code = e.code;
    if (code === 'PageUp' || code === 'KeyW') this.keys.powerUp = false;
    else if (code === 'PageDown' || code === 'KeyS') this.keys.powerDown = false;
    else if (code === 'ArrowLeft') this.keys.left = false;
    else if (code === 'ArrowRight') this.keys.right = false;
    else if (code === 'ArrowUp') this.keys.angleUp = false;
    else if (code === 'ArrowDown') this.keys.angleDown = false;
    else if (code === 'Space') this.keys.fire = false;
    this.sound.stop(SOUNDS.TURRET_MOVE);
  }

  clearKeys() {
    for (const k of Object.keys(this.keys)) this.keys[k] = false;
    this.holdingFuelLeft = false;
    this.holdingFuelRight = false;
    this.draggingAngle = false;
  }

  // Canvas pointer events are ONLY for Teleport & Air Strike destination targeting
  handleMouseMove(sx, sy) {
    this.mouseX = sx;
    this.mouseY = sy;

    if (this.airStrike && !this.airStrike.launched) {
      this.airStrike.cursorX = sx;
      this.airStrike.cursorY = sy;
    }
    if (this.teleport && !this.teleport.picked) {
      this.teleport.cursorX = sx;
      this.teleport.cursorY = sy;
    }
  }

  handleMouseDown(sx, sy) {
    this.sound.unlock();
    this.mouseX = sx;
    this.mouseY = sy;
    this.mouseDown = true;

    if (this.scene === 'battle' && this.teleport && !this.teleport.picked && this.canLocalControlSpecialOverlay()) {
      this.confirmTeleport(sx, sy);
    }
  }

  handleMouseUp(sx, sy) {
    this.mouseX = sx;
    this.mouseY = sy;
    this.mouseDown = false;

    if (this.scene === 'battle' && this.airStrike && !this.airStrike.launched && this.canLocalControlSpecialOverlay()) {
      this.launchAirStrike(sx, this.airStrike.uhel);
    }
  }

  // ==================== FULL-VIEWPORT CLEAN PAPER-CUT RENDERING ====================

  render(ctx, viewBounds = null) {
    const vb = viewBounds || { left: 0, right: STAGE_W, top: 0, bottom: STAGE_H };
    ctx.save();

    // 1. Edge-to-edge atmospheric sky, sun, soft clouds & geometric mountain silhouettes
    this.terrain.renderBackground(ctx, vb);

    // 2. Wind-driven ambient weather (snowflakes, forest leaves, desert sand motes)
    this.vfx.renderWeather(ctx, this.terrain.krajina);

    // 3. Apply subtle explosion micro-shake to foreground battlefield only
    if (this.scene === 'battle') {
      const [shakeX, shakeY] = this.vfx.getShakeOffset();
      if (shakeX || shakeY) {
        ctx.translate(shakeX, shakeY);
      }
    }

    // 4. Destructible terrain + seamless edge skirts (arena edge lines only during battle)
    this.terrain.renderColumns(ctx, vb, this.scene === 'battle');

    // 5. Two-tone faceted Paper-Cut trees
    this.terrain.renderTrees(ctx);

    // 6. Active combat entities & Paper-Cut VFX
    if (this.scene === 'battle') {
      this._renderBattleEntities(ctx);
    }

    ctx.restore();
  }

  _renderBattleEntities(ctx) {
    // 1. Pending Air Strike target flares (behind tanks/projectiles)
    if (this.pendingStrikes.length) {
      for (const s of this.pendingStrikes) {
        const pulse = 0.5 + 0.5 * Math.sin(((s.pulse || 0) / 30) * Math.PI * 2);
        const groundY = Math.min(STAGE_H - 12, this.terrain.topY(s.targetX));
        ctx.save();
        ctx.fillStyle = `rgba(239, 68, 68, ${(0.09 + pulse * 0.12).toFixed(3)})`;
        ctx.fillRect(s.targetX - 42, -120, 84, STAGE_H + 140);

        ctx.strokeStyle = `rgba(220, 38, 38, ${(0.45 + pulse * 0.4).toFixed(3)})`;
        ctx.lineWidth = 1.1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(s.targetX - 42, -120);
        ctx.lineTo(s.targetX - 42, STAGE_H);
        ctx.moveTo(s.targetX + 42, -120);
        ctx.lineTo(s.targetX + 42, STAGE_H);
        ctx.stroke();
        ctx.setLineDash([]);

        // Pulsing flare ring on ground
        ctx.beginPath();
        ctx.arc(s.targetX, groundY - 2, 4 + pulse * 4, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(239, 68, 68, ${(0.8 - pulse * 0.4).toFixed(3)})`;
        ctx.lineWidth = 1.4;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(s.targetX, groundY - 2, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = '#ef4444';
        ctx.fill();

        // Crisp pill badge
        const badgeY = Math.max(40, groundY - 26);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(s.targetX - 38, badgeY - 7, 76, 14, 7);
        else ctx.rect(s.targetX - 38, badgeY - 7, 76, 14);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#dc2626';
        ctx.font = '800 7.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('AIR STRIKE', s.targetX, badgeY + 0.3);
        ctx.restore();
      }
    }

    // 2. Tanks, double-ring shields, parachutes & overhead micro HP/nameplates
    for (const tank of this.tanks) {
      tank.render(ctx, this);
    }

    // 3. Clean Paper-Cut turn-start bouncing chevron above active tank
    if (this.blik) {
      const f = this.blik.frame;
      const alpha = f > 22 ? Math.max(0, 1 - (f - 22) / 13) : 1;
      const bounce = Math.sin(f * 0.38) * 3.5;
      const cy = this.blik.y - 34 + bounce;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(this.blik.x, cy);
      ctx.fillStyle = this.blik.col || '#0284c7';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, 5);
      ctx.lineTo(-5.5, -3);
      ctx.lineTo(5.5, -3);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // 4. Continuous Paper-Cut projectile contrails (rendered BEHIND rockets)
    this.vfx.renderTrails(ctx);

    // 5. Projectiles
    for (const proj of this.projectiles) {
      proj.render(ctx);
    }

    // 6. Shockwave rings, sparks & floating damage/bounty popups
    this.vfx.renderBattleFx(ctx);

    // 6. Teleport reticle / shimmer beam
    if (this.teleport) {
      this.teleport.render(ctx);
    }

    // 7. Air Strike targeting overlay
    if (this.airStrike) {
      this.airStrike.render(ctx);
    }
  }

  _notifyStatus() {
    this.cb.onStatusChange?.({
      scene: this.scene,
      mode: this.mode,
      round: this.gameRound,
      activePlayer: this.activeTank?.data?.name || '',
    });
  }
}
