// Master 25Hz Game Controller, Scene State Machine, Menus, HUD Panel & Shop

import {
  STAGE_W, STAGE_H, FPS, PANEL_X, PANEL_Y,
  PLAYER_COLORS, AI_DIFFICULTIES, WEAPONS, SPECIALS, SHIELD_TIERS, SOUNDS,
  MAX_UPGRADE_LEVEL, REPAIR_HEAL_AMOUNT, ROUND_BASE_STIPEND, ROUND_WIN_BONUS,
  SUDDEN_DEATH_TURN, getMaxPower, createInitialTankData,
} from './constants.js';
import { RNG } from './rng.js';
import { Terrain } from './terrain.js';
import { Tank } from './tank.js';
import { Projectile, AirStrikeController, TeleportController, spawnAirStrikeBombs, getWeaponSpec } from './weapons.js';
import { tickAI, aiBuyInShop } from './ai.js';
import { rgbToCx, alphaCx } from './renderer.js';

export class TankGame {
  constructor(renderer, sound, callbacks = {}) {
    this.renderer = renderer;
    this.sound = sound;
    this.cb = callbacks; // { onOnlineAction, onOnlineAim, onOnlineShopBuy, onOnlineShopReady, onStatusChange, onAutoSave }

    this.rng = new RNG();
    this.aiRng = new RNG(Date.now() ^ 0x5a5a5a5a);
    this.terrain = new Terrain();

    // Game mode: 'local' | 'online'
    this.mode = 'local';
    this.mySlot = 0; // 1..5 in online mode
    this.isHost = true;
    this.onlineReadySent = false;
    this.onlineReadyStatus = ''; // e.g. 'Waiting (1/2)'
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

    // Scene state: 'menu1' | 'menu2' | 'loading' | 'battle' | 'round_end' | 'shop'
    this.scene = 'menu1';
    this.quality = 'HIGH'; // 'HIGH' | 'MEDIUM' | 'LOW'

    // Title / setup menu state
    this.krajinaSetting = 0; // 0=Random, 1=Mountains, 2=Forest, 3=Desert
    this.randKrajina = true;
    this.playerCount = 2; // 2..5
    this.menu1Released = false;

    // Local player configuration state
    this.setupCur = 1;
    this.setupName = '';
    this.setupColorIdx = 3; // default 0x333333 (m4)
    this.setupType = 'tank'; // 'tank' | 'ai'
    this.setupDif = 'normal'; // m3
    this.setupAiAlpha = 0; // 0..1 fade for AI difficulty panel (Sprite 394)
    this.nameInputFocused = true;

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
    this.roundEndTimer = 0; // Sprite 402 36-frame delay
    this.projectiles = [];
    this.airStrike = null;
    this.teleport = null;
    this._aiPendingAirStrike = null;
    this._aiPendingTeleport = null;
    this.blik = null; // { x, y, frame } Sprite 225 (35 frames)

    // Panel HUD interactive state
    this.shieldsMenuOpen = false;
    this.hoverShieldTier = 0;
    this.hoverHudButton = 0; // Active HUD button ID for hover tooltips & over states
    this.draggingPower = false;
    this.draggingAngle = false;
    this.holdingFuelLeft = false;
    this.holdingFuelRight = false;

    // Blast-door curtain transition (`clona`, Sprite 247)
    this.clona = null;

    // Shop state (inside `clona`)
    this.shopCur = 0; // 1..N player currently shopping (local mode: sequential; online mode: mySlot)

    // Mouse / hover tracking in stage coords (0..550, 0..400)
    this.mouseX = 275;
    this.mouseY = 200;
    this.mouseDown = false;
    this.hoverId = null;
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
  }

  // ==================== SCENE INITIALIZERS ====================

  resetToTitle() {
    this.mode = 'local';
    this.mySlot = 0;
    this.isHost = true;
    this.scene = 'menu1';
    this.krajinaSetting = 0;
    this.randKrajina = true;
    this.playerCount = 2;
    this.menu1Released = false;
    this.clona = null;
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
    this._notifyStatus();
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

  showToast(text, color = '#ffe680', frames = 65) {
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

  _initMenu2() {
    this.scene = 'menu2';
    this.randKrajina = this.krajinaSetting === 0;
    this.playerData = [];
    for (let i = 1; i <= this.playerCount; i++) {
      this.playerData.push(
        createInitialTankData(i, '', PLAYER_COLORS[3], 'tank', 'normal', this.balancePreset)
      );
    }
    this.gameRound = 0;
    this.setupCur = 1;
    this.setupName = '';
    this.setupColorIdx = 3;
    this.setupType = 'tank';
    this.setupDif = 'normal';
    this.setupAiAlpha = 0;
    this.menu1Released = false;
    this.nameInputFocused = true;
    this._notifyStatus();
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
    this.clona = null;
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
    if (this.clona && this.scene === 'shop') {
      this.clona.purchasing = false;
      this.clona.projizdi = true;
      this.clona.openingAfterShop = true;
      this.clona.speed = -4;
      this.sound.play(SOUNDS.CLONA_DOOR, { volume: 0.75, noMultiple: true });
      this._prepareRoundData();
      this.scene = 'loading';
      this.terrain.beginGenerate(this.krajinaSetting, this.rng, false);
    } else {
      this._startNextRound();
    }
    this._notifyStatus();
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
    this.scene = 'loading';
    this.tanks = [];
    this.projectiles = [];
    this.airStrike = null;
    this.teleport = null;
    this.pendingStrikes = [];
    this.fastForward = false;
    this.blik = null;
    this.shieldsMenuOpen = false;
    this.cursorHidden = false;
    this.terrain.beginGenerate(this.krajinaSetting, this.rng, false);
    this._notifyStatus();
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
    this.draggingPower = false;
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
    // breaking equal-score ties (like Round 1 at 0-0) via deterministic seeded roll
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
    // Rank players by total_score descending to determine underdog catch-up bonus
    const ranked = [...this.playerData].sort(
      (a, b) => b.total_score - a.total_score || a.t_num - b.t_num
    );
    const leaderScore = ranked[0]?.total_score ?? 0;

    for (let i = 0; i < ranked.length; i++) {
      const pd = ranked[i];
      // Base round stipend so nobody is ever stuck broke
      pd.score += ROUND_BASE_STIPEND;
      // Underdog catch-up cash (shop budget only, doesn't inflate leaderboard score)
      if (i > 0 && pd.total_score < leaderScore) {
        pd.score += i * 1000;
      }
    }

    if (survivor) {
      survivor.data.score += ROUND_WIN_BONUS;
      survivor.data.total_score += ROUND_WIN_BONUS;
      this.showToast(
        `${survivor.data.name} WINS! +$${ROUND_WIN_BONUS} · Round stipend +$${ROUND_BASE_STIPEND}`,
        '#7ef29d',
        75
      );
    } else {
      this.showToast(`DRAW ROUND! Stipend +$${ROUND_BASE_STIPEND}`, '#ffe680', 70);
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
    this.showToast('AIR STRIKE IMPACT!', '#ff6b6b', 45);
    return true;
  }

  // Trigger tank settling check
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
      this.showToast(`SUDDEN DEATH! ${newMult.toFixed(1)}× DAMAGE`, '#ff7b54', 70);
    }

    this.turnTicksLeft = this.turnTimerSec > 0 ? this.turnTimerSec * FPS : 0;

    if (this.aliveCount > 1 && this.activeTank && this.activeTank.data.live) {
      this.blik = { x: this.activeTank.x, y: this.activeTank.y - 10, frame: 0 };
    }
    this.terrain.updateWind(this.rng);
    this.sound.stop(SOUNDS.TURRET_MOVE);
    this.activeTank.onTurnStart();
    this.shieldsMenuOpen = false;
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

  // Can the local user control the active tank right now?
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
    let idx = t.data.cur_gun;
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
    t.data.energy = Math.min(t.data.max_energy, Math.round(t.data.energy) + REPAIR_HEAL_AMOUNT);
    t.data.specials[1] = Math.max(0, t.data.specials[1] - 1);
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

    // Sync firing state over network before decrementing gun
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

    // Consume ammo (except weapon 0 = Small missile, infinite!)
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

    // Play barrel recoil animation + firing sound (subtle click/boom from button 148)
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
    // Mark newest strike as justPlanted so it waits a full enemy turn before dropping
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
    // Support cold-boot mid-match rejoin (e.g. after guest refreshes browser tab)
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

  // ==================== MID-GAME SAVE & LOAD ====================

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

    // Rebuild playerData cleanly (applying any lobby slot overrides when resuming online)
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

    this.projectiles = [];
    this.airStrike = null;
    this.teleport = null;
    this._aiPendingAirStrike = null;
    this._aiPendingTeleport = null;
    this.blik = null;
    this.shieldsMenuOpen = false;
    this.draggingPower = false;
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
      this.clona = {
        projizdi: false,
        targetScene: 'shop',
        purchasing: true,
        openingAfterShop: false,
        lx: -137.5,
        rx: 137.0,
        speed: 0,
        k: 2340,
        firstClosed: false,
        swapped: false,
      };
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
      this.showToast(`Loaded Save (Round ${this.gameRound} Shop)`, '#7ef29d', 65);
      this._notifyStatus();
      return;
    }

    // Restore exact battle terrain & tanks
    this.clona = null;
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
      this.blik = { x: this.activeTank.x, y: this.activeTank.y - 10, frame: 0 };
    }
    this.nextTank = this.turnOrder.length ? this.turnOrder[this.turnIdx % this.turnOrder.length] : null;
    this.showToast(`Loaded Save (Round ${this.gameRound})`, '#7ef29d', 65);
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
      if (this.scene !== 'shop' && !this.roundTransitioning) {
        this.roundEndPending = false;
        this.roundTransitioning = true;
        if (this.scene !== 'battle') {
          // Cold-boot directly into open shop after refresh/rejoin
          this.scene = 'shop';
          this.shopCur = this.mySlot;
          this.onlineReadySent = false;
          this.onlineReadyStatus = '';
          this.tanks = [];
          this.projectiles = [];
          this.clona = {
            projizdi: false,
            targetScene: 'shop',
            purchasing: true,
            openingAfterShop: false,
            lx: -137.5,
            rx: 137.0,
            speed: 0,
            k: 2340,
            firstClosed: false,
            swapped: false,
          };
          this.roundTransitioning = false;
        } else {
          this._spawnClona({
            projizdi: false,
            targetScene: 'shop',
            purchasing: true,
            speed: 10,
            k: 2340,
          });
        }
      }
      if (snap.forceImmediate) {
        this.showToast('Synced with host!', '#7ef29d', 50);
      }
      this._notifyStatus();
      return;
    }

    if (snap.scene !== 'battle') return;

    if (this.scene !== 'battle') {
      this.clona = null;
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
      this.blik = { x: this.activeTank.x, y: this.activeTank.y - 10, frame: 0 };
      this.activeTank.onTurnStart();
    }
    if (snap.forceImmediate) {
      this.showToast('Synced with host!', '#7ef29d', 50);
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

  // Fast-forward loading or settling frames if a remote peer is slightly ahead (e.g. after tab switch)
  _catchUpForRemote(expectedTankNumber = 0) {
    if (this._pendingStateSync) {
      this.applyStateSync(this._pendingStateSync);
    }
    let guard = 0;
    while (this.scene === 'loading' && guard < 180) {
      if (this.clona) this.clona = null;
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

  // Apply live remote aim/position updates (smooth watching of opponent's turn)
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

  // Apply remote turn action
  applyRemoteAction(msg) {
    if (!msg) return;

    if (msg.type === 'state_sync') {
      // Wait briefly if an explosion/death animation is still playing visually so explosions don't get cut off
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
      if (this.scene !== 'shop' && !this.roundTransitioning) {
        this.roundEndPending = false;
        this.roundTransitioning = true;
        this._pendingStateSync = null;
        this._spawnClona({
          projizdi: false,
          targetScene: 'shop',
          purchasing: true,
          speed: 10,
          k: 2340,
        });
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
        // Remove matching pending flare locally
        const idx = this.pendingStrikes.findIndex(
          (s) => s.targetX === msg.strike.targetX && s.ownerNum === msg.strike.ownerNum
        );
        if (idx >= 0) this.pendingStrikes.splice(idx, 1);
        spawnAirStrikeBombs(this, msg.strike);
        this.showToast('AIR STRIKE IMPACT!', '#ff6b6b', 45);
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
        // Force activeTank alignment so a remote shot is NEVER dropped
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

  // ==================== BLAST DOORS (CLONA) & SHOP ====================

  _spawnClona({ projizdi, targetScene, purchasing, speed = 16, k = 920 }) {
    this.sound.play(SOUNDS.CLONA_DOOR, { volume: 0.75, noMultiple: true });
    this.clona = {
      projizdi,
      targetScene,
      purchasing,
      openingAfterShop: false,
      lx: -411.35,
      rx: 412.5,
      speed,
      k,
      firstClosed: true,
      swapped: false,
    };
  }

  _tickClona() {
    const c = this.clona;
    if (!c) return;

    if (c.projizdi) {
      // Slide doors in to center, swap scene, then bounce back open (exact Sprite 247 `l` & `r`)
      if (c.openingAfterShop) {
        c.speed -= (137.5 + Math.abs(c.lx)) / c.k;
        c.lx += c.speed;
        c.rx -= c.speed;
        if (c.lx <= -411.35) {
          this.clona = null;
        }
        return;
      }

      c.speed -= (137.5 + Math.abs(c.lx)) / c.k;
      if (c.lx > -137.5 && !c.swapped) {
        c.lx = -137.5;
        c.rx = 137.5;
        c.swapped = true;
        if (c.targetScene === 'menu2') {
          this._initMenu2();
        }
      }
      c.lx += c.speed;
      c.rx -= c.speed;
      if (c.rx < 137.5 && !c.swapped) c.rx = 137.5;

      if (c.speed < 0 && c.lx < -411.35) {
        this.clona = null;
      }
    } else {
      // Slide doors shut and hold closed for Shop
      if (c.lx < -137.5) {
        c.speed -= (137.5 + Math.abs(c.lx)) / c.k;
        if (c.speed < 1.5) c.speed = 1.5;
        c.lx += c.speed;
        c.rx -= c.speed;
        if (c.lx >= -137.5) {
          c.lx = -137.5;
          c.rx = 137.0;
        }
      } else {
        c.lx = -137.5;
        c.rx = 137.0;
        if (c.firstClosed) {
          c.firstClosed = false;
          this._openShop();
        }
      }
    }
  }

  _openShop() {
    this.scene = 'shop';
    this.tanks = [];
    this.projectiles = [];
    this.airStrike = null;
    this.teleport = null;
    this.pendingStrikes = [];
    this.fastForward = false;
    this.blik = null;
    this.terrain.vitr = 0;

    if (this.mode === 'online') {
      // Simultaneous shopping for local player's slot; host executes AI shopping and syncs buys
      this.shopCur = this.mySlot;
      this.onlineReadySent = false;
      this.onlineReadyStatus = '';
      if (this.isHost) {
        for (let slot = 1; slot <= this.playerCount; slot++) {
          if (this.playerData[slot - 1].type === 'ai') {
            aiBuyInShop(slot, this);
          }
        }
        this.cb.onAutoSave?.(this.buildSaveData('Auto-Save (Shop)'));
      }
    } else {
      // Sequential shopping for humans; AI bots buy items with their earned cash
      this.shopCur = 0;
      this._shopNextPlayer();
      if (this.scene === 'shop') {
        this.cb.onAutoSave?.(this.buildSaveData('Auto-Save (Shop)'));
      }
    }
    this._notifyStatus();
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
        return; // Human player's turn to shop
      }
      // AI bot shops using its own earned score & exact shop prices
      aiBuyInShop(this.shopCur, this);
    }

    // All players finished shopping -> open doors and start next round!
    this._prepareRoundData();
    this.scene = 'loading';
    this.terrain.beginGenerate(this.krajinaSetting, this.rng, false);
    if (this.clona) {
      this.clona.purchasing = false;
      this.clona.projizdi = true;
      this.clona.openingAfterShop = true;
      this.clona.speed = -4;
      this.sound.play(SOUNDS.CLONA_DOOR, { volume: 0.75, noMultiple: true });
    }
    this._notifyStatus();
  }

  _shopButtonCaption() {
    if (this.mode === 'online') {
      return this.onlineReadySent ? (this.onlineReadyStatus || 'Waiting...') : 'Ready!';
    }
    for (let i = this.shopCur + 1; i <= this.playerCount; i++) {
      if (this.playerData[i - 1].type === 'tank') return 'Next player';
    }
    return 'Start!';
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

  tick() {
    // Blast-door curtain always ticks
    if (this.clona) {
      this._tickClona();
    }

    if (this.scene === 'menu2') {
      // Smoothly fade AI difficulty box (Sprite 394, speed = 2/100 per frame)
      if (this.setupType === 'ai' && this.setupAiAlpha < 1) {
        this.setupAiAlpha = Math.min(1, this.setupAiAlpha + 0.04);
      } else if (this.setupType === 'tank' && this.setupAiAlpha > 0) {
        this.setupAiAlpha = Math.max(0, this.setupAiAlpha - 0.04);
      }
      return;
    }

    if (this.scene === 'loading') {
      // Wait for clona to finish opening if still covering screen
      const pct = this.terrain.stepGenerate(this.rng, 40);
      if (pct >= 100 && !this.clona) {
        this._enterBattle();
      }
      return;
    }

    if (this.scene === 'battle') {
      if (this.fastForward && !this.isBotsOnlyAlive()) {
        this.fastForward = false;
      }
      this.terrain.tick();

      // Turn blink arrow (Sprite 225: 35 frames)
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

      // Tick all projectiles (iterate over snapshot so spawned clusters tick cleanly)
      if (this.projectiles.length) {
        const snapshot = this.projectiles.slice();
        for (const proj of snapshot) {
          proj.tick(this);
        }
        this.projectiles = this.projectiles.filter((p) => !p.done);
      }

      // Tick AI controller if active tank is AI (and locally owned: always in local mode, host-only in online mode)
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

      // Build human input for active tank (including HUD fuel buttons)
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

      // Optional Turn Timer countdown (auto-acts on timeout so rounds never stall)
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
            this.showToast(`${this.activeTank.data.name} time up! Auto-firing...`, '#ff9b6a', 45);
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
            // In online mode, host processes delayed Air Strikes & advances turn authoritatively
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
      // In online mode, host awards round payouts and triggers open_shop authoritatively
      if (
        (this.mode !== 'online' || this.isHost) &&
        this.aliveCount < 2 &&
        !this.roundEndPending &&
        !this.roundTransitioning &&
        !this.clona &&
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
          this._spawnClona({
            projizdi: false,
            targetScene: 'shop',
            purchasing: true,
            speed: 10,
            k: 2340,
          });
        }
      }
    }
  }

  // ==================== INPUT HANDLERS ====================

  handleKeyDown(e) {
    this.sound.unlock();
    const code = e.code;
    const key = e.key;

    // Menu 2 Name text typing
    if (this.scene === 'menu2' && !this.clona) {
      if (code === 'Enter') {
        e.preventDefault();
        this._confirmMenu2Player();
        return;
      }
      if (code === 'Backspace') {
        e.preventDefault();
        this.setupName = this.setupName.slice(0, -1);
        return;
      }
      if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && this.setupName.length < 14) {
        e.preventDefault();
        this.setupName += key;
        return;
      }
      return;
    }

    if (this.scene === 'menu1' && !this.clona && code === 'Enter') {
      e.preventDefault();
      this._confirmMenu1();
      return;
    }

    if (this.scene === 'shop' && code === 'Enter') {
      e.preventDefault();
      this._shopNextPlayer();
      return;
    }

    if (this.scene !== 'battle') return;

    // Air strike direction flip (Left/Right arrows, exact Sprite 65)
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

    // Weapon cycling: Q / E
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

    // Power: PageUp / PageDown or W / S
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
    this.draggingPower = false;
    this.draggingAngle = false;
  }

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

    if (this.scene === 'battle' && this.canLocalControl()) {
      const t = this.activeTank;
      // Power slider drag (panel (442.6, 28.4) + pow (-283.6, -25.9), sy = 0.44087)
      if (this.draggingPower) {
        const localY = (sy - (PANEL_Y - 25.9)) / 0.440872;
        const maxPow = getMaxPower(t.data.energy);
        const minY = Math.max(0, 100 - maxPow);
        const clampedY = Math.max(minY, Math.min(100, localY));
        t.power = Math.round(100 - clampedY);
      }
      // Angle slider drag (panel (442.6, 28.4) + angle (-227.3, -22.0), sx = 0.31676)
      if (this.draggingAngle) {
        const localX = (sx - (PANEL_X - 227.3)) / 0.316757;
        const clampedX = Math.max(-90, Math.min(90, localX));
        t.rotace = Math.round(90 + clampedX);
        this.sound.play(SOUNDS.TURRET_MOVE, { volume: 0.35, noMultiple: true });
      }
      // Track hovered Battle HUD button for over/down states & tooltips
      const px = sx - PANEL_X;
      const py = sy - PANEL_Y;
      this.hoverHudButton = 0;
      this.hoverShieldTier = 0;
      if (this.shieldsMenuOpen) {
        const fx = -356.8;
        const fy = -3.5;
        if (Math.abs(px - fx) > 44 || Math.abs(py - fy) > 16) {
          this.shieldsMenuOpen = false;
        } else {
          const xs = [-28.5, -13.9, 0.0, 14.3, 28.2];
          const btnIds = [194, 198, 206, 213, 219];
          for (let i = 0; i < 5; i++) {
            if (Math.abs(px - (fx + xs[i])) <= 7.5 && Math.abs(py - fy) <= 10) {
              if (i < 4) this.hoverShieldTier = i + 1;
              this.hoverHudButton = btnIds[i];
              break;
            }
          }
        }
      } else if (py >= -28 && py <= 23) {
        if (this._inBox(px, py, -226, 1, -198, 21)) this.hoverHudButton = 148;
        else if (py >= -26 && py <= -7 && px >= -190 && px <= -171) this.hoverHudButton = 122;
        else if (py >= -26 && py <= -7 && px >= -51 && px <= -32) this.hoverHudButton = 123;
        else if (py >= -11 && py <= 4 && px >= -428 && px <= -412) this.hoverHudButton = 136;
        else if (py >= -11 && py <= 4 && px >= -388 && px <= -372) this.hoverHudButton = 137;
        else if (this._inBox(px, py, -395, 4, -365, 22)) this.hoverHudButton = 166;
        else if (this._inBox(px, py, -365, 4, -335, 22)) this.hoverHudButton = t.par ? 176 : 173;
        else if (this._inBox(px, py, -335, 4, -305, 22)) this.hoverHudButton = 182;
        else if (this._inBox(px, py, -365, -11, -349, 4)) this.hoverHudButton = 188;
      }
    } else {
      this.hoverHudButton = 0;
      this.hoverShieldTier = 0;
    }
  }

  handleMouseDown(sx, sy) {
    this.sound.unlock();
    this.mouseX = sx;
    this.mouseY = sy;
    this.mouseDown = true;

    // Teleport target click (Sprite 305 mouseDown)
    if (this.scene === 'battle' && this.teleport && !this.teleport.picked && this.canLocalControlSpecialOverlay()) {
      this.confirmTeleport(sx, sy);
      return;
    }

    if (this.scene === 'battle' && this.canLocalControl()) {
      const px = sx - PANEL_X;
      const py = sy - PANEL_Y;

      // Power slider grab (panel-local x around -283.6 ± 10, y -26..+20)
      if (px >= -294 && px <= -273 && py >= -28 && py <= 20) {
        this.draggingPower = true;
        this.handleMouseMove(sx, sy);
        return;
      }
      // Angle slider grab (panel-local x around -227.3 ± 30, y -28..-16)
      if (px >= -258 && px <= -196 && py >= -28 && py <= -16) {
        this.draggingAngle = true;
        this.handleMouseMove(sx, sy);
        return;
      }
      // Fuel Left/Right buttons (Sprite 139 at (-400.15, -2.9), buttons at ±19.4)
      if (!this.shieldsMenuOpen && py >= -11 && py <= 4) {
        if (px >= -428 && px <= -412) {
          this.holdingFuelLeft = true;
          this.sound.play(SOUNDS.UI_CLICK, { volume: 0.6 });
          return;
        }
        if (px >= -388 && px <= -372) {
          this.holdingFuelRight = true;
          this.sound.play(SOUNDS.UI_CLICK, { volume: 0.6 });
          return;
        }
      }
    }
  }

  handleMouseUp(sx, sy) {
    this.mouseX = sx;
    this.mouseY = sy;
    this.mouseDown = false;
    const wasDraggingAngle = this.draggingAngle;
    const wasDragging = this.draggingPower || this.draggingAngle || this.holdingFuelLeft || this.holdingFuelRight;
    this.draggingPower = false;
    this.draggingAngle = false;
    if (wasDraggingAngle) this.sound.stop(SOUNDS.TURRET_MOVE);
    this.holdingFuelLeft = false;
    this.holdingFuelRight = false;

    // Air strike target launch (Sprite 65 mouseUp)
    if (this.scene === 'battle' && this.airStrike && !this.airStrike.launched && this.canLocalControlSpecialOverlay()) {
      this.launchAirStrike(sx, this.airStrike.uhel);
      return;
    }

    if (wasDragging || this.clona && this.scene !== 'shop') return;

    if (this.scene === 'menu1') {
      this._clickMenu1(sx, sy);
    } else if (this.scene === 'menu2') {
      this._clickMenu2(sx, sy);
    } else if (this.scene === 'battle') {
      this._clickBattleHUD(sx, sy);
    } else if (this.scene === 'shop') {
      this._clickShop(sx, sy);
    }
  }

  _inBox(x, y, x1, y1, x2, y2) {
    return x >= x1 && x <= x2 && y >= y1 && y <= y2;
  }

  _confirmMenu1() {
    if (this.menu1Released) return;
    this.menu1Released = true;
    this.sound.play(SOUNDS.UI_CLICK, { volume: 0.8 });
    this._spawnClona({
      projizdi: true,
      targetScene: 'menu2',
      purchasing: false,
      speed: 16,
      k: 920,
    });
  }

  _clickMenu1(sx, sy) {
    if (this.menu1Released) return;
    // Terrain radio rows inside Sprite 331 at (80.7, 217.6):
    // m1 (Mountains=1) y=-30 -> stage 187.6; m2 (Forest=2) y=-10 -> 207.6; m3 (Desert=3) y=+10 -> 227.6; m4 (Random=0) y=+30 -> 247.6
    const terrainRows = [
      { k: 1, cy: 188 },
      { k: 2, cy: 208 },
      { k: 3, cy: 228 },
      { k: 0, cy: 248 },
    ];
    for (const r of terrainRows) {
      if (this._inBox(sx, sy, 68, r.cy - 9, 185, r.cy + 9)) {
        this.krajinaSetting = r.k;
        this.sound.play(SOUNDS.UI_CLICK, { volume: 0.7 });
        return;
      }
    }

    // Player count + / - inside Sprite 344 at (94.5, 343.2):
    // '-' Button 343 at local (17.5, 0) -> stage (112, 343.2)
    // '+' Button 342 at local (40.0, 0) -> stage (134.5, 343.2)
    if (this._inBox(sx, sy, 101, 330, 123, 356)) {
      if (this.playerCount > 2) {
        this.playerCount--;
        this.sound.play(SOUNDS.UI_CLICK, { volume: 0.7 });
      }
      return;
    }
    if (this._inBox(sx, sy, 124, 330, 148, 356)) {
      if (this.playerCount < 5) {
        this.playerCount++;
        this.sound.play(SOUNDS.UI_CLICK, { volume: 0.7 });
      }
      return;
    }

    // Next arrow Button 335 at (516.5, 373.6), bounds [500.4, 535.3, 361.2, 385.9]
    if (this._inBox(sx, sy, 496, 358, 540, 390)) {
      this._confirmMenu1();
    }
  }

  _confirmMenu2Player() {
    if (this.setupCur > this.playerCount) return;
    this.sound.play(SOUNDS.UI_CLICK, { volume: 0.8 });
    const pd = this.playerData[this.setupCur - 1];
    pd.name = this.setupName.trim() || `Player ${this.setupCur}`;
    pd.col = PLAYER_COLORS[this.setupColorIdx];
    pd.type = this.setupType;
    if (this.setupType === 'ai') pd.dif = this.setupDif;

    this.setupName = '';
    this.setupCur++;
    if (this.setupCur > this.playerCount) {
      this._startNextRound();
    }
  }

  _clickMenu2(sx, sy) {
    // 6 Color radios inside Sprite 377 at (244.9, 228.8), x offsets: -35, -15, +5, +25, +45, +65
    const colorOffsets = [-35, -15, 5, 25, 45, 65];
    for (let i = 0; i < 6; i++) {
      const cx = 244.9 + colorOffsets[i];
      if (this._inBox(sx, sy, cx - 9, 219, cx + 9, 239)) {
        this.setupColorIdx = i;
        this.sound.play(SOUNDS.UI_CLICK, { volume: 0.7 });
        return;
      }
    }

    // Computer controlled checkbox at (310.1, 251.3)
    if (this._inBox(sx, sy, 298, 240, 322, 263)) {
      this.setupType = this.setupType === 'tank' ? 'ai' : 'tank';
      this.sound.play(SOUNDS.UI_CLICK, { volume: 0.7 });
      return;
    }

    // AI difficulty radios inside Sprite 394 (397.4, 219.9) -> Sprite 393 (+32.9, +10.7) = (430.3, 230.6)
    // m1..m5 at y offsets: -50, -25, 0, +25, +50
    if (this.setupType === 'ai') {
      const difY = [-50, -25, 0, 25, 50];
      for (let i = 0; i < 5; i++) {
        const cy = 230.6 + difY[i];
        if (this._inBox(sx, sy, 352, cy - 11, 444, cy + 11)) {
          this.setupDif = AI_DIFFICULTIES[i];
          this.sound.play(SOUNDS.UI_CLICK, { volume: 0.7 });
          return;
        }
      }
    }

    // Next / START! button 379 at (292.6, 272.8), bounds [276.5, 311.4, 260.4, 285.1]
    if (this._inBox(sx, sy, 272, 257, 316, 289)) {
      this._confirmMenu2Player();
    }
  }

  _clickBattleHUD(sx, sy) {
    const px = sx - PANEL_X;
    const py = sy - PANEL_Y;

    // Quality radio buttons (always clickable): rad1..3 at (50.8, -20.1 / -5.0 / +10.0)
    if (px >= 42 && px <= 105) {
      if (py >= -27 && py <= -13) { this.quality = 'HIGH'; this.sound.play(SOUNDS.UI_CLICK, { volume: 0.5 }); return; }
      if (py >= -12 && py <= 2) { this.quality = 'MEDIUM'; this.sound.play(SOUNDS.UI_CLICK, { volume: 0.5 }); return; }
      if (py >= 3 && py <= 18) { this.quality = 'LOW'; this.sound.play(SOUNDS.UI_CLICK, { volume: 0.5 }); return; }
    }

    if (!this.canLocalControl()) return;

    // Shields flyout menu when open (centered at (-356.8, -3.5))
    if (this.shieldsMenuOpen) {
      const fx = -356.8;
      const fy = -3.5;
      const xs = [-28.5, -13.9, 0.0, 14.3, 28.2];
      for (let i = 0; i < 5; i++) {
        if (Math.abs(px - (fx + xs[i])) <= 7.5 && Math.abs(py - fy) <= 10) {
          if (i < 4) this.activateShield(i + 1);
          else this.disableShield();
          return;
        }
      }
      this.shieldsMenuOpen = false;
      return;
    }

    // Weapon selector prev / next (ico at (-110.9, -17.1), btn122 at -70, btn123 at +69)
    if (py >= -26 && py <= -7) {
      if (px >= -190 && px <= -171) { this.cycleWeapon(-1); return; }
      if (px >= -51 && px <= -32) { this.cycleWeapon(1); return; }
    }

    // Fire button (148 at (-212.45, 10.65), bounds [-224, -200, 2, 19])
    if (this._inBox(px, py, -226, 1, -198, 21)) {
      this.fireCurrentTank();
      return;
    }

    // Repair button (168 at (-386.4, 12.8))
    if (this._inBox(px, py, -395, 4, -365, 22)) {
      this.useRepair();
      return;
    }

    // Parachutes toggle button (177 at (-356.7, 13.0))
    if (this._inBox(px, py, -365, 4, -335, 22)) {
      this.toggleParachute();
      return;
    }

    // Teleport button (184 at (-326.4, 13.0))
    if (this._inBox(px, py, -335, 4, -305, 22)) {
      this.beginTeleport();
      return;
    }

    // Shields button (221 at (-356.8, -3.5))
    if (this._inBox(px, py, -365, -11, -349, 4)) {
      this.shieldsMenuOpen = true;
      this.sound.play(SOUNDS.UI_CLICK, { volume: 0.6 });
      return;
    }
  }

  _clickShop(sx, sy) {
    if (this.mode === 'online' && this.onlineReadySent) return;
    // Shop coordinates are in clona space centered at (275, 200)
    const cx = sx - 275;
    const cy = sy - 200;

    // Weapons column: x = -140, width [-82, 102], y = -140 + 18.1 * i
    for (let i = 0; i < WEAPONS.length; i++) {
      const ry = -140 + 18.1 * i;
      if (this._inBox(cx, cy, -222, ry - 8.5, -38, ry + 8.5)) {
        this.applyShopPurchase(this.shopCur, 'weapon', i);
        return;
      }
    }

    // Specials column: x = +140, width [-82, 102], y = -140 + 17.7 * i (exact Sprite 256 _height = 17.7)
    for (let i = 0; i < SPECIALS.length; i++) {
      const ry = -140 + 17.7 * i;
      if (this._inBox(cx, cy, 58, ry - 8.5, 242, ry + 8.5)) {
        this.applyShopPurchase(this.shopCur, 'special', i);
        return;
      }
    }

    // Next player / Start! / Ready! button (`buymenu` at (+140, +80), bounds [-55, 55, -13, 15.3])
    if (this._inBox(cx, cy, 85, 65, 195, 97)) {
      this._shopNextPlayer();
    }
  }

  // ==================== RENDERING ====================

  render(ctx) {
    ctx.save();
    ctx.fillStyle = '#000099';
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);

    if (this.scene === 'menu1') {
      this._renderMenu1(ctx);
    } else if (this.scene === 'menu2') {
      this._renderMenu2(ctx);
    } else if (this.scene === 'loading') {
      this._renderLoading(ctx);
    } else if (this.scene === 'battle') {
      this._renderBattle(ctx);
    }

    // Render blast doors (`clona`) & Shop overlay if active
    if (this.clona) {
      this._renderClona(ctx);
    }

    ctx.restore();
  }

  _renderMenu1(ctx) {
    const renderer = this.renderer;
    // Background bitmap (Sprite 320 at 274.9, 199.9)
    ctx.save();
    ctx.translate(274.9, 199.9);
    renderer.drawSprite(ctx, 320);
    ctx.restore();

    // Box Shape 321
    renderer.drawShape(ctx, 321);

    // Static headings & controls text
    ctx.save(); ctx.translate(240.55, 195.0); ctx.scale(1, 0.92); renderer.drawText(ctx, 322); ctx.restore();
    ctx.save(); ctx.translate(70.0, 148.8);   renderer.drawText(ctx, 336); ctx.restore();
    ctx.save(); ctx.translate(86.0, 260.0);   renderer.drawText(ctx, 337); ctx.restore();
    ctx.save(); ctx.translate(221.85, 148.85); renderer.drawText(ctx, 338); ctx.restore();
    ctx.save(); ctx.translate(53.55, 285.4);  ctx.scale(1, 0.92); renderer.drawText(ctx, 339); ctx.restore();

    // Terrain selector Sprite 331 at (80.65, 217.6)
    ctx.save();
    ctx.translate(80.65, 217.6);
    renderer.drawSprite(ctx, 331, {
      overrides: {
        m1: { frame: this.krajinaSetting === 1 ? 1 : 0 },
        m2: { frame: this.krajinaSetting === 2 ? 1 : 0 },
        m3: { frame: this.krajinaSetting === 3 ? 1 : 0 },
        m4: { frame: this.krajinaSetting === 0 ? 1 : 0 },
      },
    });
    ctx.restore();

    // Player count Sprite 344 at (94.5, 343.2)
    ctx.save();
    ctx.translate(94.5, 343.2);
    renderer.drawSprite(ctx, 344, {
      vars: { pocet: String(this.playerCount) },
    });
    ctx.restore();

    // Next arrow button at (516.5, 373.55)
    const overNext = this._inBox(this.mouseX, this.mouseY, 496, 358, 540, 390);
    ctx.save();
    ctx.translate(516.5, 373.55);
    ctx.scale(0.342, 0.342);
    renderer.drawButton(ctx, 335, undefined, overNext ? (this.mouseDown ? 'down' : 'over') : 'up');
    ctx.restore();
  }

  _renderMenu2(ctx) {
    const renderer = this.renderer;
    // Background bitmap
    ctx.save();
    ctx.translate(274.9, 199.9);
    renderer.drawSprite(ctx, 320);
    ctx.restore();

    // Main setup panel shape 362
    renderer.drawShape(ctx, 362);

    // Checkbox Sprite 365 (`check`) at (310.1, 251.3)
    ctx.save();
    ctx.translate(310.1, 251.3);
    renderer.drawSprite(ctx, 365, { frame: this.setupType === 'ai' ? 1 : 0 });
    ctx.restore();

    // Player header (`cislo`: "Player 1"..) at (148.9, 154.8)
    ctx.save();
    ctx.translate(148.9, 154.8);
    renderer.drawEditText(ctx, 367, undefined, { cislo: `Player ${this.setupCur}` });
    ctx.restore();

    // "Name:" label & input box
    ctx.save(); ctx.translate(156.0, 193.8); renderer.drawText(ctx, 368); ctx.restore();
    ctx.save();
    ctx.translate(204.0, 193.8);
    renderer.drawEditText(ctx, 369, undefined, { name: this.setupName });
    ctx.restore();

    // "Color:" label & 6-color picker Sprite 377 at (244.9, 228.85)
    ctx.save(); ctx.translate(156.0, 220.0); renderer.drawText(ctx, 370); ctx.restore();
    ctx.save();
    ctx.translate(244.9, 228.85);
    renderer.drawSprite(ctx, 377, {
      overrides: {
        m1: { frame: this.setupColorIdx === 0 ? 1 : 0 },
        m2: { frame: this.setupColorIdx === 1 ? 1 : 0 },
        m3: { frame: this.setupColorIdx === 2 ? 1 : 0 },
        m4: { frame: this.setupColorIdx === 3 ? 1 : 0 },
        m5: { frame: this.setupColorIdx === 4 ? 1 : 0 },
        m6: { frame: this.setupColorIdx === 5 ? 1 : 0 },
      },
    });
    ctx.restore();

    // "computer controlled:" label
    ctx.save(); ctx.translate(156.0, 243.3); renderer.drawText(ctx, 380); ctx.restore();

    // Bottom caption (`uk`: "Next player" or "START ! ") & Next button
    const ukText = this.setupCur === this.playerCount ? 'START ! ' : 'Next player';
    ctx.save();
    ctx.translate(137.15, 261.6);
    renderer.drawEditText(ctx, 378, undefined, { uk: ukText });
    ctx.restore();

    const overNext = this._inBox(this.mouseX, this.mouseY, 272, 257, 316, 289);
    ctx.save();
    ctx.translate(292.6, 272.75);
    ctx.scale(0.342, 0.342);
    renderer.drawButton(ctx, 379, undefined, overNext ? (this.mouseDown ? 'down' : 'over') : 'up');
    ctx.restore();

    // AI difficulty side panel Sprite 394 at (397.4, 219.9)
    if (this.setupAiAlpha > 0.01) {
      ctx.save();
      ctx.translate(397.4, 219.9);
      renderer.drawSprite(ctx, 394, {
        cx: alphaCx(this.setupAiAlpha),
        overrides: {
          '#393': {
            overrides: {
              m1: { frame: this.setupDif === 'Very_easy' ? 1 : 0 },
              m2: { frame: this.setupDif === 'easy' ? 1 : 0 },
              m3: { frame: this.setupDif === 'normal' ? 1 : 0 },
              m4: { frame: this.setupDif === 'hard' ? 1 : 0 },
              m5: { frame: this.setupDif === 'very_hard' ? 1 : 0 },
            },
          },
        },
      });
      ctx.restore();
    }
  }

  _renderLoading(ctx) {
    const renderer = this.renderer;
    const pct = this.terrain._genState
      ? Math.min(100, Math.round((this.terrain._genState.i / STAGE_W) * 100))
      : 100;
    const barW = pct * 2; // 0..200
    const barX = -95.3 + pct;
    ctx.save();
    ctx.translate(275, 200);
    renderer.drawSprite(ctx, 399, {
      overrides: {
        percent: {
          x: barX,
          y: 0,
          xscale: Math.max(0.01, barW / 200),
          yscale: 1,
        },
      },
    });
    ctx.restore();
  }

  _renderBattle(ctx) {
    const renderer = this.renderer;

    // 1. Landscape sky/mountains/sun/clouds
    this.terrain.renderBackground(ctx, renderer);

    // 2. Terrain 550 vertical columns
    this.terrain.renderColumns(ctx);

    // 3. Trees (strom_1 / strom_2)
    this.terrain.renderTrees(ctx, renderer);

    // 4. Tanks, barrels, parachutes, shields
    for (const tank of this.tanks) {
      tank.render(ctx, renderer);
    }

    // 5. Turn indicator arrow (`blk`, Sprite 225)
    if (this.blik) {
      ctx.save();
      ctx.translate(this.blik.x, this.blik.y);
      renderer.drawSprite(ctx, 'blk', { frame: Math.min(34, this.blik.frame) });
      ctx.restore();
    }

    // 5b. Pending Air Strike target flares (pulsing red danger zone)
    if (this.pendingStrikes.length) {
      for (const s of this.pendingStrikes) {
        const pulse = 0.5 + 0.5 * Math.sin(((s.pulse || 0) / 30) * Math.PI * 2);
        const groundY = Math.min(STAGE_H - 12, this.terrain.topY(s.targetX));
        ctx.save();
        // Translucent vertical laser danger zone
        ctx.fillStyle = `rgba(255, 50, 50, ${0.12 + pulse * 0.16})`;
        ctx.fillRect(s.targetX - 42, 54, 84, STAGE_H - 54);
        // Dashed laser border lines
        ctx.strokeStyle = `rgba(255, 85, 85, ${0.45 + pulse * 0.45})`;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(s.targetX - 42, 54);
        ctx.lineTo(s.targetX - 42, STAGE_H);
        ctx.moveTo(s.targetX + 42, 54);
        ctx.lineTo(s.targetX + 42, STAGE_H);
        ctx.stroke();
        ctx.setLineDash([]);
        // Ground flare beacon
        ctx.beginPath();
        ctx.arc(s.targetX, groundY - 3, 4 + pulse * 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 60, 40, ${0.65 + pulse * 0.35})`;
        ctx.fill();
        // Warning label
        ctx.fillStyle = 'rgba(0,0,0,0.72)';
        ctx.fillRect(s.targetX - 40, Math.max(60, groundY - 26), 80, 14);
        ctx.fillStyle = '#ff7b7b';
        ctx.font = 'bold 8.5px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('! AIR STRIKE !', s.targetX, Math.max(67, groundY - 19));
        ctx.restore();
      }
    }

    // 6. Projectiles & Explosions
    for (const proj of this.projectiles) {
      proj.render(ctx, renderer);
    }

    // 7. Teleport animation / cursor
    if (this.teleport) {
      this.teleport.render(ctx, renderer);
    }

    // 8. HUD Panel (`panel`, Sprite 222 at (442.6, 28.4))
    this._renderPanel(ctx);

    // 9. Air Strike cursor (above panel, depth 1100000)
    if (this.airStrike) {
      this.airStrike.render(ctx, renderer);
    }
  }

  _renderPanel(ctx) {
    const renderer = this.renderer;
    const t = this.activeTank || this.nextTank || this.tanks[0];
    if (!t) return;
    const pd = t.data;
    const isHumanCtrl = this.canLocalControl();
    const curWeapon = WEAPONS[pd.cur_gun] || WEAPONS[0];
    const gunCount = pd.guns[pd.cur_gun] ?? 0;

    // Compute sorted scoreboard order (descending by total_score, deterministic tie-break)
    const ranked = [...this.playerData].sort((a, b) => b.total_score - a.total_score || a.t_num - b.t_num);
    const scoreYs = [28.3, 42.45, 56.6, 70.75, 84.9];

    ctx.save();
    ctx.translate(PANEL_X, PANEL_Y);

    // Determine specials frame states matching panel child refresh() methods
    const repairFrame = (isHumanCtrl && pd.energy < pd.max_energy && pd.specials[1] > 0) ? 0 : 1;
    const parFrame = (!isHumanCtrl || pd.specials[0] <= 0) ? 2 : (t.par ? 1 : 0);
    const telFrame = (isHumanCtrl && pd.specials[7] > 0) ? 0 : 1;
    const shFrame = !isHumanCtrl ? 2 : (this.shieldsMenuOpen ? 1 : 0);

    const hudBtnStates = this.hoverHudButton
      ? { [this.hoverHudButton]: this.mouseDown ? 'down' : 'over' }
      : null;

    renderer.drawSprite(ctx, 'panel', {
      frame: 0,
      buttonStates: hudBtnStates,
      vars: {
        power: String(Math.round(t.power)),
        rotation: String(Math.round(t.rotace)),
        energy: String(Math.round(pd.energy)),
        fuel: String(Math.round(pd.fuel)),
        score: String(Math.round(pd.score)),
        vitr: String(Math.abs(Math.round(this.terrain.vitr))),
      },
      overrides: {
        name: {
          cx: rgbToCx(pd.col),
          vars: { name: pd.name },
        },
        vitr_uk: {
          xscale: this.terrain.vitr / 100,
          yscale: 0.83134,
        },
        ico: {
          vars: {
            name: curWeapon.name,
            count: String(gunCount),
          },
          afterDraw: (c, renderer) => {
            c.save();
            c.translate(-55, 0);
            renderer.drawSprite(c, curWeapon.icon);
            c.restore();
          },
        },
        pow: {
          overrides: {
            pow: { y: 100 - t.power },
            shadow: { y: -getMaxPower(pd.energy) },
          },
        },
        '#145': {
          overrides: {
            drag: { x: -90 + t.rotace },
          },
        },
        fuel_ar: {
          frame: this.shieldsMenuOpen ? 1 : 0,
        },
        tank: {
          overrides: {
            hlaven: {
              x: -0.05,
              y: -0.75,
              rotation: t.rotace,
              xscale: 1,
              yscale: 1,
            },
          },
        },
        rad1: { frame: this.quality === 'HIGH' ? 1 : 0 },
        rad2: { frame: this.quality === 'MEDIUM' ? 1 : 0 },
        rad3: { frame: this.quality === 'LOW' ? 1 : 0 },
        repair: {
          frame: repairFrame,
          vars: { count: String(pd.specials[1]) },
        },
        parachutes: {
          frame: parFrame,
          vars: { count: String(pd.specials[0]) },
        },
        teleport: {
          frame: telFrame,
          vars: { count: String(pd.specials[7]) },
        },
        shields: {
          frame: shFrame,
          overrides: {
            sh1: {
              frame: (pd.specials[3] > 0 && !t.shActive && !t.shieldUsedThisRound) ? (this.hoverShieldTier === 1 ? 1 : 0) : 2,
              vars: { count: String(pd.specials[3]) },
            },
            sh2: {
              frame: (pd.specials[4] > 0 && !t.shActive && !t.shieldUsedThisRound) ? (this.hoverShieldTier === 2 ? 1 : 0) : 2,
              vars: { count: String(pd.specials[4]) },
            },
            sh3: {
              frame: (pd.specials[5] > 0 && !t.shActive && !t.shieldUsedThisRound) ? (this.hoverShieldTier === 3 ? 1 : 0) : 2,
              vars: { count: String(pd.specials[5]) },
            },
            sh4: {
              frame: (pd.specials[6] > 0 && !t.shActive && !t.shieldUsedThisRound) ? (this.hoverShieldTier === 4 ? 1 : 0) : 2,
              vars: { count: String(pd.specials[6]) },
            },
            sh_d: {
              frame: t.shActive ? 0 : 1,
            },
          },
        },
      },
    });

    // Render sorted score_tab list on right side of screen (x=36, y=28.3..84.9)
    for (let i = 0; i < ranked.length; i++) {
      const p = ranked[i];
      ctx.save();
      ctx.translate(36, scoreYs[i]);
      renderer.drawSprite(ctx, 'score_tab', {
        cx: rgbToCx(p.col),
        vars: {
          name: p.name,
          score: String(Math.round(p.total_score)),
        },
      });
      ctx.restore();
    }

    ctx.restore();

    // Subtle battle status banners (Sudden Death, 4x Bot Skip, Turn Timer, Online Wait, Event Toast)
    let bannerY = 53;
    const dmgMult = this.getDamageMultiplier();
    if (dmgMult > 1) {
      ctx.save();
      ctx.fillStyle = 'rgba(130, 20, 10, 0.82)';
      ctx.fillRect(8, bannerY, 138, 16);
      ctx.strokeStyle = '#ff7b54';
      ctx.lineWidth = 1;
      ctx.strokeRect(8, bannerY, 138, 16);
      ctx.fillStyle = '#ffe0b2';
      ctx.font = 'bold 9px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`SUDDEN DEATH · ${dmgMult.toFixed(1)}x DMG`, 77, bannerY + 8);
      ctx.restore();
    }

    if (this.fastForward && this.isBotsOnlyAlive()) {
      const ffY = dmgMult > 1 ? bannerY + 19 : bannerY;
      ctx.save();
      ctx.fillStyle = 'rgba(38, 87, 168, 0.88)';
      ctx.fillRect(8, ffY, 114, 16);
      ctx.strokeStyle = '#7db0ff';
      ctx.lineWidth = 1;
      ctx.strokeRect(8, ffY, 114, 16);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('>> 4x BOT BATTLE', 65, ffY + 8);
      ctx.restore();
    }

    if (this.turnTimerSec > 0 && this.activeTank && this.activeTank.type === 'tank' && this.activeTank.playing) {
      const secs = Math.max(0, Math.ceil(this.turnTicksLeft / FPS));
      const urgent = secs <= 5;
      ctx.save();
      ctx.fillStyle = urgent ? 'rgba(180, 24, 24, 0.86)' : 'rgba(0, 0, 0, 0.65)';
      ctx.fillRect(390, 53, 56, 17);
      ctx.fillStyle = urgent ? '#ffd54f' : '#e2ecff';
      ctx.font = 'bold 10px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`⏱ ${secs}s`, 418, 61.5);
      ctx.restore();
    }

    if (this.mode === 'online' && this.activeTank && this.activeTank.playing) {
      const isMine = this.activeTank.type === 'tank' && this.activeTank.tankNumber === this.mySlot;
      if (!isMine) {
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.58)';
        ctx.fillRect(175, bannerY, 200, 18);
        ctx.fillStyle = '#ffe680';
        ctx.font = 'bold 10px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`Waiting for ${pd.name}...`, 275, bannerY + 9);
        ctx.restore();
        bannerY += 20;
      }
    }

    if (this.bannerToast) {
      ctx.save();
      ctx.font = 'bold 10px Arial, sans-serif';
      const w = Math.min(360, Math.max(180, ctx.measureText(this.bannerToast.text).width + 24));
      ctx.fillStyle = 'rgba(10, 14, 24, 0.78)';
      ctx.fillRect(275 - w / 2, bannerY, w, 18);
      ctx.strokeStyle = this.bannerToast.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(275 - w / 2, bannerY, w, 18);
      ctx.fillStyle = this.bannerToast.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.bannerToast.text, 275, bannerY + 9);
      ctx.restore();
    }
  }

  _renderClona(ctx) {
    const renderer = this.renderer;
    const c = this.clona;
    const showShop = this.scene === 'shop' && c.purchasing && this.shopCur >= 1 && this.shopCur <= this.playerCount;
    const pd = showShop ? this.playerData[this.shopCur - 1] : null;

    ctx.save();
    ctx.translate(275, 200);

    // Draw left & right metallic blast doors (`l` cid=232, `r` cid=239)
    ctx.save();
    ctx.translate(c.lx, 0);
    renderer.drawSprite(ctx, 232);
    ctx.restore();

    ctx.save();
    ctx.translate(c.rx, 0);
    renderer.drawSprite(ctx, 239);
    ctx.restore();

    if (showShop && pd) {
      // Score & Player header
      ctx.save();
      ctx.translate(-152.5, -188.1);
      renderer.drawSprite(ctx, 234, { vars: { score: String(Math.round(pd.score)) } });
      ctx.restore();

      ctx.save();
      ctx.translate(-139.0, -171.0);
      renderer.drawSprite(ctx, 236, {
        cx: rgbToCx(pd.col),
        vars: { player: pd.name },
      });
      ctx.restore();

      // Weapons list (left column x = -140, y = -140 + 18.1*i)
      for (let i = 0; i < WEAPONS.length; i++) {
        const w = WEAPONS[i];
        const afford = pd.score >= w.price;
        const ry = -140 + 18.1 * i;
        ctx.save();
        ctx.translate(-140, ry);
        renderer.drawSprite(ctx, 'weapon', {
          vars: {
            w_caption: afford ? w.name : '',
            w2_caption: afford ? '' : w.name,
            w_price: String(w.price),
            w_count: String(w.pack),
            t_count: String(pd.guns[i]),
          },
        });
        ctx.save();
        ctx.translate(-74, 0.4);
        renderer.drawSprite(ctx, w.icon);
        ctx.restore();
        ctx.restore();
      }

      // Specials list (right column x = +140, y = -140 + 17.7*i)
      for (let i = 0; i < SPECIALS.length; i++) {
        const s = SPECIALS[i];
        const maxed = Boolean(s.maxLevel && pd.specials[i] >= s.maxLevel);
        const afford = !maxed && pd.score >= s.price;
        const countLabel = s.maxLevel
          ? (maxed ? 'MAX' : `${pd.specials[i]}/${s.maxLevel}`)
          : String(pd.specials[i]);
        const ry = -140 + 17.7 * i;
        ctx.save();
        ctx.translate(140, ry);
        renderer.drawSprite(ctx, 'special', {
          vars: {
            w_caption: afford ? s.name : '',
            w2_caption: afford ? '' : s.name,
            w_price: maxed ? 'MAX' : String(s.price),
            w_count: String(s.pack),
            t_count: countLabel,
          },
        });
        ctx.save();
        ctx.translate(-74, 0.4);
        renderer.drawSprite(ctx, s.icon);
        ctx.restore();
        ctx.restore();
      }

      // Next player / Start! / Ready! button (`buymenu` at (+140, +80))
      const overBtn = this._inBox(this.mouseX - 275, this.mouseY - 200, 85, 65, 195, 97);
      ctx.save();
      ctx.translate(140, 80);
      renderer.drawSprite(ctx, 'buymenu', {
        vars: { but_capt: this._shopButtonCaption() },
        buttonStates: { 242: overBtn ? (this.mouseDown ? 'down' : 'over') : 'up' },
      });
      ctx.restore();
    }

    ctx.restore();
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
