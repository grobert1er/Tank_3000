// Entry point: Full-viewport HiDPI Paper-Cut canvas, Fullscreen mode, 25Hz simulation loop,
// unified HTML/CSS HUD & Armory Shop, Local Setup, Mid-Game Saves, and Online/LAN Lobby

import {
  STAGE_W, STAGE_H, FPS, FRAME_MS,
  PLAYER_COLORS, AI_DIFFICULTIES, AI_DIFFICULTY_LABELS,
  WEAPONS, SPECIALS, SHIELD_TIERS, getMaxPower,
} from './constants.js';
import { VectorRenderer } from './renderer.js';
import { SoundManager } from './audio.js';
import { TankGame } from './game.js';
import { NetworkClient, getLastRoomSession } from './network.js';

const COLOR_HEX = PLAYER_COLORS.map((c) => '#' + c.toString(16).padStart(6, '0'));

function hexIntToCss(col) {
  return '#' + ((col ?? 0x333333) >>> 0).toString(16).padStart(6, '0');
}

// Clean geometric inline SVG icons for Weapon Pill, Weapon Drawer, and Armory Shop
function getWeaponSvg(w) {
  const kind = w?.kind || 'missile';
  if (kind === 'roller') {
    const col = w.uphill ? '#0284c7' : '#475569';
    return `<svg viewBox="0 0 20 20" width="16" height="16"><circle cx="10" cy="10" r="6.5" fill="${col}"/><circle cx="8" cy="8" r="2" fill="rgba(255,255,255,0.45)"/>${w.uphill ? '<path d="M10 5 L13 9 L7 9 Z" fill="#fff"/>' : ''}</svg>`;
  }
  if (kind === 'astrike') {
    return `<svg viewBox="0 0 20 20" width="16" height="16"><path d="M18 10 L5 5 L8 10 L5 15 Z" fill="#0f172a"/><circle cx="10" cy="10" r="2" fill="#ef4444"/></svg>`;
  }
  if (kind === 'funky' || kind === 'mirv' || kind === 'death') {
    const col = kind === 'death' ? '#dc2626' : kind === 'mirv' ? '#0284c7' : '#ea580c';
    return `<svg viewBox="0 0 20 20" width="16" height="16"><circle cx="10" cy="6" r="2.7" fill="${col}"/><circle cx="6" cy="13" r="2.7" fill="${col}"/><circle cx="14" cy="13" r="2.7" fill="${col}"/></svg>`;
  }
  if (w.id === 3 || w.id === 2) {
    const col = w.id === 3 ? '#dc2626' : '#ea580c';
    return `<svg viewBox="0 0 20 20" width="16" height="16"><circle cx="10" cy="10" r="6.8" fill="${col}"/><circle cx="10" cy="10" r="3" fill="#fef08a"/></svg>`;
  }
  return `<svg viewBox="0 0 20 20" width="16" height="16"><path d="M16 4 L12 13 L9 11 L7 8 Z" fill="#1e293b"/><path d="M16 4 L12.8 7.2 L12.8 4 Z" fill="#f97316"/><circle cx="6" cy="14" r="2.2" fill="#fb923c"/></svg>`;
}

function getSpecialSvg(id) {
  switch (id) {
    case 0: // Parachutes
      return `<svg viewBox="0 0 20 20" width="16" height="16"><path d="M3 10 A7 7 0 0 1 17 10 Z" fill="#f97316"/><path d="M5 10 L10 16 L15 10" fill="none" stroke="#475569" stroke-width="1.4"/></svg>`;
    case 1: // Repair
      return `<svg viewBox="0 0 20 20" width="16" height="16"><rect x="8" y="3" width="4" height="14" rx="1.5" fill="#16a34a"/><rect x="3" y="8" width="14" height="4" rx="1.5" fill="#16a34a"/></svg>`;
    case 2: // Fuel
      return `<svg viewBox="0 0 20 20" width="16" height="16"><rect x="4" y="5" width="10" height="12" rx="2" fill="#d97706"/><path d="M6 5 L6 3 L12 3 L12 5" fill="none" stroke="#92400e" stroke-width="1.5"/><path d="M14 8 L16.5 10 L16.5 14.5" fill="none" stroke="#92400e" stroke-width="1.5"/></svg>`;
    case 3:
    case 4:
    case 5:
    case 6: { // Shields
      const cols = ['#38bdf8', '#0284c7', '#6366f1', '#9333ea'];
      const c = cols[id - 3] || '#0284c7';
      return `<svg viewBox="0 0 20 20" width="16" height="16"><path d="M10 2.5 L16.5 5.2 L16.5 10.5 C16.5 14.3 13.6 16.8 10 18 C6.4 16.8 3.5 14.3 3.5 10.5 L3.5 5.2 Z" fill="${c}" fill-opacity="0.22" stroke="${c}" stroke-width="1.8"/></svg>`;
    }
    case 7: // Teleport
      return `<svg viewBox="0 0 20 20" width="16" height="16"><circle cx="10" cy="10" r="6" fill="none" stroke="#0284c7" stroke-width="1.7"/><circle cx="10" cy="10" r="2.2" fill="#38bdf8"/><path d="M10 1.5 V4.5 M10 15.5 V18.5 M1.5 10 H4.5 M15.5 10 H18.5" stroke="#0284c7" stroke-width="1.5"/></svg>`;
    default: // Permanent upgrades 8..11
      return `<svg viewBox="0 0 20 20" width="16" height="16"><path d="M10 3 L16 10 H12.5 V17 H7.5 V10 H4 Z" fill="#0284c7"/></svg>`;
  }
}

async function boot() {
  const viewportRoot = document.getElementById('viewport-root');
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');

  // Floating menu utility bar
  const menuUtilBar = document.getElementById('menu-util-bar');
  const btnMenuHome = document.getElementById('btn-menu-home');
  const btnMenuResync = document.getElementById('btn-menu-resync');
  const btnMenuSaves = document.getElementById('btn-menu-saves');
  const btnMenuMute = document.getElementById('btn-menu-mute');
  const btnMenuControls = document.getElementById('btn-menu-controls');
  const btnMenuFullscreen = document.getElementById('btn-menu-fullscreen');

  // Screen overlays
  const screenTitle = document.getElementById('screen-title');
  const bootStatus = document.getElementById('boot-status');
  const btnTitleLocal = document.getElementById('btn-title-local');
  const btnTitleOnline = document.getElementById('btn-title-online');
  const btnTitleContinue = document.getElementById('btn-title-continue');
  const titleContinueSub = document.getElementById('title-continue-sub');
  const btnTitleSaves = document.getElementById('btn-title-saves');
  const btnTitleControls = document.getElementById('btn-title-controls');

  const screenLocalSetup = document.getElementById('screen-local-setup');
  const btnSetupBack = document.getElementById('btn-setup-back');
  const setupTerrainEl = document.getElementById('setup-terrain');
  const setupPresetEl = document.getElementById('setup-preset');
  const setupTimerEl = document.getElementById('setup-timer');
  const setupPlayersList = document.getElementById('setup-players-list');
  const btnSetupAddPlayer = document.getElementById('btn-setup-add-player');
  const btnSetupStart = document.getElementById('btn-setup-start');

  // Battle HUD elements
  const hudBattle = document.getElementById('hud-battle');
  const hudPlayerDot = document.getElementById('hud-player-dot');
  const hudPlayerName = document.getElementById('hud-player-name');
  const hudHpFill = document.getElementById('hud-hp-fill');
  const hudHpText = document.getElementById('hud-hp-text');
  const hudShieldChip = document.getElementById('hud-shield-chip');
  const hudShieldVal = document.getElementById('hud-shield-val');
  const hudCash = document.getElementById('hud-cash');
  const btnHudMenu = document.getElementById('btn-hud-menu');
  const btnHudSaves = document.getElementById('btn-hud-saves');
  const btnHudOnline = document.getElementById('btn-hud-online');
  const btnHudControls = document.getElementById('btn-hud-controls');
  const btnHudMute = document.getElementById('btn-hud-mute');
  const btnResync = document.getElementById('btn-resync');
  const btnFastForward = document.getElementById('btn-fast-forward');
  const btnAwayBot = document.getElementById('btn-away-bot');
  const hudRound = document.getElementById('hud-round');
  const hudWindArrow = document.getElementById('hud-wind-arrow');
  const hudWindBar = document.getElementById('hud-wind-bar');
  const hudWindVal = document.getElementById('hud-wind-val');
  const hudTimerBadge = document.getElementById('hud-timer-badge');
  const hudSdBadge = document.getElementById('hud-sd-badge');
  const hudFfBadge = document.getElementById('hud-ff-badge');
  const hudBanner = document.getElementById('hud-banner');
  const hudScoreboard = document.getElementById('hud-scoreboard');
  const btnFullscreen = document.getElementById('btn-fullscreen');

  // Bottom Command Dock & Popovers
  const commandDock = document.getElementById('command-dock');
  const weaponDrawer = document.getElementById('weapon-drawer');
  const weaponDrawerGrid = document.getElementById('weapon-drawer-grid');
  const shieldPopover = document.getElementById('shield-popover');
  const shieldPopoverNote = document.getElementById('shield-popover-note');
  const shieldPopoverList = document.getElementById('shield-popover-list');
  const btnDriveLeft = document.getElementById('btn-drive-left');
  const dockFuelVal = document.getElementById('dock-fuel-val');
  const btnDriveRight = document.getElementById('btn-drive-right');
  const dockAngleVal = document.getElementById('dock-angle-val');
  const dockAngleSlider = document.getElementById('dock-angle-slider');
  const dockPowerVal = document.getElementById('dock-power-val');
  const dockMaxpowCap = document.getElementById('dock-maxpow-cap');
  const dockPowerSlider = document.getElementById('dock-power-slider');
  const dockPowerLock = document.getElementById('dock-power-lock');
  const btnWeaponPrev = document.getElementById('btn-weapon-prev');
  const btnWeaponDrawer = document.getElementById('btn-weapon-drawer');
  const dockWeaponIcon = document.getElementById('dock-weapon-icon');
  const dockWeaponName = document.getElementById('dock-weapon-name');
  const dockWeaponAmmo = document.getElementById('dock-weapon-ammo');
  const btnWeaponNext = document.getElementById('btn-weapon-next');
  const btnSpRepair = document.getElementById('btn-sp-repair');
  const spRepairCnt = document.getElementById('sp-repair-cnt');
  const btnSpPara = document.getElementById('btn-sp-para');
  const spParaCnt = document.getElementById('sp-para-cnt');
  const btnSpShield = document.getElementById('btn-sp-shield');
  const spShieldCnt = document.getElementById('sp-shield-cnt');
  const btnSpTele = document.getElementById('btn-sp-tele');
  const spTeleCnt = document.getElementById('sp-tele-cnt');
  const btnFire = document.getElementById('btn-fire');

  // Armory Shop elements
  const screenShop = document.getElementById('screen-shop');
  const shopPlayerDot = document.getElementById('shop-player-dot');
  const shopPlayerName = document.getElementById('shop-player-name');
  const shopRoundBadge = document.getElementById('shop-round-badge');
  const shopCashVal = document.getElementById('shop-cash-val');
  const shopToast = document.getElementById('shop-toast');
  const shopWeaponsList = document.getElementById('shop-weapons-list');
  const shopSpecialsList = document.getElementById('shop-specials-list');
  const shopScoreboard = document.getElementById('shop-scoreboard');
  const btnShopNext = document.getElementById('btn-shop-next');

  // Modals
  const controlsModal = document.getElementById('controls-modal');
  const lobbyModal = document.getElementById('lobby-modal');
  const savesModal = document.getElementById('saves-modal');
  const savesStatus = document.getElementById('saves-status');
  const saveNameInput = document.getElementById('save-name-input');
  const btnSaveNow = document.getElementById('btn-save-now');
  const saveNowHint = document.getElementById('save-now-hint');
  const savesListEl = document.getElementById('saves-list');
  const btnImportSave = document.getElementById('btn-import-save');
  const importSaveFile = document.getElementById('import-save-file');

  const lobbyEntry = document.getElementById('lobby-entry');
  const lobbyRoom = document.getElementById('lobby-room');
  const lobbyErr = document.getElementById('lobby-error');
  const inputName = document.getElementById('lobby-name');
  const inputCode = document.getElementById('lobby-code');
  const selectTransport = document.getElementById('lobby-transport');
  const lobbyHint = document.getElementById('lobby-hint');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const btnJoinRoom = document.getElementById('btn-join-room');
  const roomCodeDisp = document.getElementById('room-code-display');
  const roomSlotsEl = document.getElementById('room-slots');
  const roomTerrainEl = document.getElementById('room-terrain');
  const roomPresetEl = document.getElementById('room-preset');
  const roomTimerEl = document.getElementById('room-timer');
  const btnLobbyLoadSave = document.getElementById('btn-lobby-load-save');
  const lobbySaveBanner = document.getElementById('lobby-save-banner');
  const lobbySaveTitle = document.getElementById('lobby-save-title');
  const lobbySaveSub = document.getElementById('lobby-save-sub');
  const btnClearLobbySave = document.getElementById('btn-clear-lobby-save');
  const btnAddBot = document.getElementById('btn-add-bot');
  const btnStartOnline = document.getElementById('btn-start-online');
  const btnCopyInvite = document.getElementById('btn-copy-invite');

  // ==================== FULL-VIEWPORT HiDPI CANVAS MAPPING ====================

  let vp = {
    cssW: window.innerWidth || 1280,
    cssH: window.innerHeight || 720,
    dpr: window.devicePixelRatio || 1,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    viewBounds: { left: 0, right: STAGE_W, top: 0, bottom: STAGE_H },
  };

  function computeViewport() {
    const cssW = Math.max(320, viewportRoot.clientWidth || window.innerWidth);
    const cssH = Math.max(240, viewportRoot.clientHeight || window.innerHeight);
    const dpr = window.devicePixelRatio || 1;

    // Reserve clean visual headroom for top pills and bottom floating Command Dock
    const topSafe = Math.round(Math.min(54, cssH * 0.075));
    const botSafe = Math.round(Math.min(82, cssH * 0.114));
    const availW = Math.max(280, cssW - 16);
    const availH = Math.max(200, cssH - topSafe - botSafe);

    const scale = Math.min(availW / STAGE_W, availH / STAGE_H);
    const offsetX = (cssW - STAGE_W * scale) / 2;
    const offsetY = topSafe + (availH - STAGE_H * scale) / 2;

    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    vp = {
      cssW,
      cssH,
      dpr,
      scale,
      offsetX,
      offsetY,
      viewBounds: {
        left: -offsetX / scale,
        right: (cssW - offsetX) / scale,
        top: -offsetY / scale,
        bottom: (cssH - offsetY) / scale,
      },
    };
  }

  window.addEventListener('resize', computeViewport);
  new ResizeObserver(computeViewport).observe(viewportRoot);
  computeViewport();

  // ==================== FULLSCREEN SUPPORT ====================

  function syncFullscreenButtons() {
    const isFs = Boolean(document.fullscreenElement);
    const glyph = isFs ? '⤢' : '⛶';
    const title = isFs ? 'Exit Fullscreen (F)' : 'Enter Fullscreen (F)';
    btnMenuFullscreen.textContent = glyph;
    btnMenuFullscreen.title = title;
    btnFullscreen.textContent = glyph;
    btnFullscreen.title = title;
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  btnMenuFullscreen.addEventListener('click', toggleFullscreen);
  btnFullscreen.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    syncFullscreenButtons();
    computeViewport();
  });
  syncFullscreenButtons();

  // ==================== LOAD AUDIO & ASSETS ====================

  bootStatus.hidden = false;
  bootStatus.textContent = 'Loading audio assets...';
  const renderer = new VectorRenderer();
  const data = await renderer.load('assets/game-assets.json');
  const sound = new SoundManager();
  await sound.loadAll(data.sounds || {});
  bootStatus.hidden = true;

  let game = null;
  let net = null;

  // ==================== MID-GAME SAVE STORAGE ====================

  const AUTOSAVE_KEY = 'tank3000_autosave_v1';
  const SAVES_KEY = 'tank3000_saves_v1';
  const MAX_MANUAL_SAVES = 10;

  function readAutoSave() {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeAutoSave(save) {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(save));
      refreshTitleContinueBtn();
    } catch (err) {
      console.warn('Auto-save failed:', err);
    }
  }

  function readManualSaves() {
    try {
      const raw = localStorage.getItem(SAVES_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function writeManualSaves(arr) {
    try {
      localStorage.setItem(SAVES_KEY, JSON.stringify(arr.slice(0, MAX_MANUAL_SAVES)));
    } catch (err) {
      console.warn('Save storage failed:', err);
    }
  }

  function refreshTitleContinueBtn() {
    const auto = readAutoSave();
    if (auto && Array.isArray(auto.playerData) && auto.playerData.length >= 2) {
      btnTitleContinue.hidden = false;
      const names = auto.playerData.map((p) => p.name).join(' vs ');
      titleContinueSub.textContent = `Round ${auto.gameRound || 1} (${auto.scene === 'shop' ? 'Shop' : 'Battle'}) · ${names}`;
    } else {
      btnTitleContinue.hidden = true;
    }
  }

  // ==================== LOCAL SETUP ROSTER STATE ====================

  let setupPlayers = [
    { name: 'Player 1', col: PLAYER_COLORS[0], type: 'tank', dif: 'normal' },
    { name: 'Commander AI', col: PLAYER_COLORS[2], type: 'ai', dif: 'normal' },
  ];

  function renderLocalSetupPlayers() {
    setupPlayersList.innerHTML = '';
    setupPlayers.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'setup-player-row';

      const badge = document.createElement('span');
      badge.className = 'setup-badge';
      badge.textContent = `P${idx + 1}`;

      const nameInp = document.createElement('input');
      nameInp.type = 'text';
      nameInp.className = 'setup-name-input';
      nameInp.maxLength = 14;
      nameInp.value = p.name;
      nameInp.placeholder = `Player ${idx + 1}`;
      nameInp.addEventListener('input', () => {
        p.name = nameInp.value;
      });

      const colors = document.createElement('div');
      colors.className = 'slot-colors';
      PLAYER_COLORS.forEach((colInt, ci) => {
        const takenBy = setupPlayers.find((other, oIdx) => oIdx !== idx && other.col === colInt);
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'color-dot' + (p.col === colInt ? ' active' : '') + (takenBy ? ' taken' : '');
        dot.style.background = COLOR_HEX[ci];
        dot.disabled = Boolean(takenBy);
        dot.title = takenBy ? `Taken by ${takenBy.name || 'another player'}` : 'Choose tank color';
        dot.addEventListener('click', () => {
          if (setupPlayers.some((other, oIdx) => oIdx !== idx && other.col === colInt)) return;
          p.col = colInt;
          sound.play(121, { volume: 0.5 });
          renderLocalSetupPlayers();
        });
        colors.appendChild(dot);
      });

      const toggle = document.createElement('div');
      toggle.className = 'type-toggle';
      const btnHuman = document.createElement('button');
      btnHuman.type = 'button';
      btnHuman.textContent = 'Human';
      btnHuman.className = p.type === 'tank' ? 'active' : '';
      btnHuman.addEventListener('click', () => {
        p.type = 'tank';
        if (p.name.startsWith('Bot ') || p.name === 'Commander AI') p.name = `Player ${idx + 1}`;
        renderLocalSetupPlayers();
      });
      const btnAi = document.createElement('button');
      btnAi.type = 'button';
      btnAi.textContent = 'AI';
      btnAi.className = p.type === 'ai' ? 'active' : '';
      btnAi.addEventListener('click', () => {
        p.type = 'ai';
        if (p.name === `Player ${idx + 1}`) p.name = `Bot ${idx + 1}`;
        renderLocalSetupPlayers();
      });
      toggle.append(btnHuman, btnAi);

      const right = document.createElement('div');
      right.className = 'slot-right';
      if (p.type === 'ai') {
        const sel = document.createElement('select');
        sel.className = 'setup-dif-select';
        AI_DIFFICULTIES.forEach((d) => {
          const opt = document.createElement('option');
          opt.value = d;
          opt.textContent = AI_DIFFICULTY_LABELS[d];
          if (p.dif === d) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', () => { p.dif = sel.value; });
        right.appendChild(sel);
      }

      if (setupPlayers.length > 2) {
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'btn-mini';
        rm.textContent = '×';
        rm.title = 'Remove player';
        rm.addEventListener('click', () => {
          setupPlayers.splice(idx, 1);
          renderLocalSetupPlayers();
        });
        right.appendChild(rm);
      }

      row.append(badge, nameInp, colors, toggle, right);
      setupPlayersList.appendChild(row);
    });
    btnSetupAddPlayer.disabled = setupPlayers.length >= 5;
  }

  // ==================== ONLINE LOBBY RENDERING ====================

  function showLobbyError(msg) {
    lobbyErr.textContent = msg || '';
    lobbyErr.hidden = !msg;
  }

  function renderLobby(lobby) {
    showLobbyError('');
    lobbyEntry.hidden = true;
    lobbyRoom.hidden = false;
    roomCodeDisp.textContent = lobby.code;
    roomTerrainEl.value = String(lobby.krajina);
    roomTerrainEl.disabled = !lobby.isHost;
    roomPresetEl.value = lobby.preset || 'balanced';
    roomPresetEl.disabled = !lobby.isHost || Boolean(lobby.loadedSaveInfo);
    roomTimerEl.value = String(lobby.turnTimer || 0);
    roomTimerEl.disabled = !lobby.isHost;
    btnLobbyLoadSave.hidden = !lobby.isHost;

    if (lobby.loadedSaveInfo) {
      lobbySaveBanner.hidden = false;
      lobbySaveTitle.textContent = `Resuming Save · Round ${lobby.loadedSaveInfo.round} (${lobby.loadedSaveInfo.scene === 'shop' ? 'Shop' : 'Battle'})`;
      lobbySaveSub.textContent = (lobby.loadedSaveInfo.players || [])
        .map((p) => `${p.name}: ${p.score}`)
        .join(' · ');
      btnClearLobbySave.hidden = !lobby.isHost;
    } else {
      lobbySaveBanner.hidden = true;
    }

    btnAddBot.hidden = !lobby.isHost || Boolean(lobby.loadedSaveInfo) || lobby.slots.length >= 5;
    btnStartOnline.hidden = !lobby.isHost;
    btnStartOnline.textContent = lobby.loadedSaveInfo ? 'Resume Match' : 'Start Match';
    btnStartOnline.disabled = lobby.slots.length < 2;

    let activeEditIdx = null;
    let activeEditVal = null;
    let activeSelStart = null;
    let activeSelEnd = null;
    if (document.activeElement && document.activeElement.classList?.contains('slot-name-input')) {
      activeEditIdx = Number(document.activeElement.dataset.slotIdx);
      activeEditVal = document.activeElement.value;
      activeSelStart = document.activeElement.selectionStart;
      activeSelEnd = document.activeElement.selectionEnd;
    }

    roomSlotsEl.innerHTML = '';
    let refocusInput = null;

    lobby.slots.forEach((s, idx) => {
      const row = document.createElement('div');
      row.className = 'slot-row' + (s.isMe ? ' is-me' : '');

      const badge = document.createElement('span');
      badge.className = 'slot-badge';
      badge.textContent = s.kind === 'human' ? (s.isHost ? 'HOST' : 'P' + s.slot) : 'BOT';

      const canEditName = s.isMe || (lobby.isHost && s.kind === 'ai');
      let nameNode;
      if (canEditName) {
        const nameWrap = document.createElement('div');
        nameWrap.className = 'slot-name-edit';

        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'slot-name-input';
        inp.maxLength = 14;
        inp.dataset.slotIdx = String(idx);
        inp.value = activeEditIdx === idx && activeEditVal !== null ? activeEditVal : s.name;
        inp.title = s.isMe ? 'Edit your player name' : 'Edit bot name';
        inp.setAttribute('aria-label', s.isMe ? 'Your player name' : `Bot ${s.slot} name`);

        let debounceTimer = null;
        const commitRename = (allowRestore = true) => {
          if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
          }
          const nextName = inp.value.trim().slice(0, 14);
          if (!nextName) {
            if (allowRestore) inp.value = s.name;
            return;
          }
          if (nextName === s.name) return;
          if (s.isMe) {
            inputName.value = nextName;
            net.updateProfile({ name: nextName });
          } else if (lobby.isHost && s.kind === 'ai') {
            net.hostConfig('set_bot_name', { index: idx, name: nextName });
          }
        };

        inp.addEventListener('input', () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => commitRename(false), 350);
        });
        inp.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            commitRename(true);
            inp.blur();
          } else if (ev.key === 'Escape') {
            if (debounceTimer) clearTimeout(debounceTimer);
            inp.value = s.name;
            inp.blur();
          }
        });
        inp.addEventListener('blur', () => commitRename(true));

        nameWrap.appendChild(inp);
        if (s.isMe) {
          const youTag = document.createElement('span');
          youTag.className = 'you-tag';
          youTag.textContent = '(You)';
          nameWrap.appendChild(youTag);
        }
        nameNode = nameWrap;
        if (activeEditIdx === idx) refocusInput = inp;
      } else {
        const nameEl = document.createElement('span');
        nameEl.className = 'slot-name';
        nameEl.textContent = s.name;
        nameNode = nameEl;
      }

      const swatches = document.createElement('div');
      swatches.className = 'slot-colors';
      PLAYER_COLORS.forEach((colInt, ci) => {
        const takenBy = lobby.slots.find((other, oIdx) => oIdx !== idx && other.col === colInt);
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'color-dot' + (s.col === colInt ? ' active' : '') + (takenBy ? ' taken' : '');
        sw.style.background = COLOR_HEX[ci];
        const canEditColor = s.isMe || (lobby.isHost && s.kind === 'ai');
        sw.disabled = !canEditColor || Boolean(takenBy);
        sw.title = takenBy
          ? `Taken by ${takenBy.name || 'another player'}`
          : (canEditColor ? 'Choose tank color' : '');
        sw.addEventListener('click', () => {
          if (takenBy) return;
          if (s.isMe) net.updateProfile({ col: colInt });
          else if (lobby.isHost && s.kind === 'ai') net.hostConfig('set_slot_col', { index: idx, col: colInt });
        });
        swatches.appendChild(sw);
      });

      const rightEl = document.createElement('div');
      rightEl.className = 'slot-right';
      if (s.kind === 'ai') {
        const sel = document.createElement('select');
        sel.className = 'dif-select';
        sel.disabled = !lobby.isHost;
        AI_DIFFICULTIES.forEach((d) => {
          const opt = document.createElement('option');
          opt.value = d;
          opt.textContent = AI_DIFFICULTY_LABELS[d];
          if (s.dif === d) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', () => net.hostConfig('set_bot_dif', { index: idx, dif: sel.value }));
        rightEl.appendChild(sel);

        if (lobby.isHost && !lobby.loadedSaveInfo && lobby.slots.length > 2) {
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'btn-mini';
          rm.textContent = '×';
          rm.title = 'Remove Bot';
          rm.addEventListener('click', () => net.hostConfig('remove_slot', { index: idx }));
          rightEl.appendChild(rm);
        }
      } else {
        const isAway = s.connected === false;
        const tag = document.createElement('span');
        tag.className = 'slot-status' + (isAway ? ' reconnecting' : '');
        tag.textContent = isAway ? 'Away' : 'Online';
        rightEl.appendChild(tag);

        if (isAway && lobby.isHost && !s.isHost && lobby.slots.length > 2) {
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'btn-mini';
          rm.textContent = '×';
          rm.title = 'Remove away player';
          rm.addEventListener('click', () => net.hostConfig('remove_slot', { index: idx }));
          rightEl.appendChild(rm);
        }
      }

      row.append(badge, nameNode, swatches, rightEl);
      roomSlotsEl.appendChild(row);
    });

    if (refocusInput) {
      refocusInput.focus();
      if (activeSelStart !== null && activeSelEnd !== null) {
        try { refocusInput.setSelectionRange(activeSelStart, activeSelEnd); } catch {}
      }
    }
  }

  // ==================== NETWORK CLIENT & CONTEXTUAL BUTTONS ====================

  let stepSimulation = () => {};
  let currentAwaySlots = [];
  let onlineStatusBanner = '';

  function refreshAwayButton() {
    if (game && game.mode === 'online' && game.isHost && currentAwaySlots.length > 0) {
      const target = currentAwaySlots[0];
      btnAwayBot.textContent = `${target.name} away → Bot`;
      btnAwayBot.dataset.slot = String(target.slot);
      btnAwayBot.hidden = false;
    } else {
      btnAwayBot.hidden = true;
    }
  }

  function refreshResyncButtons() {
    const show = Boolean(game && game.mode === 'online' && (game.scene === 'battle' || game.scene === 'shop'));
    const label = game?.isHost ? '🔄 Sync All' : '🔄 Resync';
    const title = game?.isHost
      ? 'Broadcast authoritative state snapshot to all connected players'
      : 'Re-pull full match state from the host (or reconnect if disconnected)';

    btnResync.hidden = !(show && game.scene === 'battle');
    btnResync.textContent = label;
    btnResync.title = title;

    btnMenuResync.hidden = !(show && game.scene === 'shop');
    btnMenuResync.textContent = label;
    btnMenuResync.title = title;
  }

  function handleResyncClick() {
    if (!game || game.mode !== 'online') return;
    if (game.isHost) {
      net.sendAction({
        type: 'state_sync',
        forceImmediate: true,
        ...game.buildSyncSnapshot(),
      });
      game.showToast('Synced all players!', '#16a34a', 45);
    } else {
      onlineStatusBanner = `Resyncing ${net.roomCode || ''}...`;
      net.requestSync();
    }
  }

  btnResync.addEventListener('click', handleResyncClick);
  btnMenuResync.addEventListener('click', handleResyncClick);

  btnAwayBot.addEventListener('click', () => {
    const slotNum = Number(btnAwayBot.dataset.slot || 0);
    if (slotNum > 0) net.replaceAwayWithBot(slotNum);
  });

  btnFastForward.addEventListener('click', () => {
    if (!game) return;
    game.setFastForward(!game.fastForward);
  });

  net = new NetworkClient({
    onConnectionChange: (ok) => {
      if (!ok && game && game.mode === 'online') {
        onlineStatusBanner = `Reconnecting to ${net.roomCode || 'room'}...`;
      } else if (ok) {
        onlineStatusBanner = '';
      }
    },
    onAwaySlotsChange: (awayList) => {
      currentAwaySlots = awayList || [];
      refreshAwayButton();
    },
    onReconnecting: (isReconnecting) => {
      onlineStatusBanner = isReconnecting ? `Reconnecting to ${net.roomCode || 'room'}...` : '';
    },
    onLobbyState: (lobby) => {
      renderLobby(lobby);
    },
    onLeftRoom: () => {
      lobbyRoom.hidden = true;
      lobbyEntry.hidden = false;
      currentAwaySlots = [];
      onlineStatusBanner = '';
      refreshAwayButton();
      refreshResyncButtons();
    },
    onMatchStart: (msg) => {
      lobbyModal.hidden = true;
      savesModal.hidden = true;
      onlineStatusBanner = '';
      game.startOnlineMatch({
        seed: msg.seed,
        krajina: msg.krajina,
        preset: msg.preset,
        turnTimer: msg.turnTimer,
        savedState: msg.savedState || null,
        players: msg.players,
        mySlot: msg.mySlot,
        isHost: msg.isHost,
      });
      refreshAwayButton();
      refreshResyncButtons();
    },
    onRejoinedMatch: (msg) => {
      lobbyModal.hidden = true;
      savesModal.hidden = true;
      game.mode = 'online';
      game.mySlot = msg.mySlot;
      game.isHost = Boolean(msg.isHost);
      onlineStatusBanner = `Rejoined ${msg.code || ''} · Syncing...`;
      refreshAwayButton();
      refreshResyncButtons();
    },
    onPeerReclaimed: ({ slot, name }) => {
      stepSimulation(performance.now());
      if (game && game.mode === 'online' && slot >= 1 && slot <= game.playerData.length) {
        game.playerData[slot - 1].type = 'tank';
        if (game.tanks[slot - 1]) {
          game.tanks[slot - 1].type = 'tank';
          game.tanks[slot - 1].firstFrame = true;
        }
        game.showToast(`${name || game.playerData[slot - 1].name} rejoined!`, '#16a34a', 55);
      }
    },
    onRemoteAim: (payload) => {
      stepSimulation(performance.now());
      game.applyRemoteAim(payload);
    },
    onRemoteAction: (payload) => {
      stepSimulation(performance.now());
      if (payload?.type === 'state_sync') onlineStatusBanner = '';
      game.applyRemoteAction(payload);
    },
    onShopStatus: ({ ready, total }) => {
      game.onlineReadyStatus = `Waiting (${ready}/${total})`;
    },
    onNextRound: ({ seed }) => {
      stepSimulation(performance.now());
      game.startOnlineNextRound(seed);
    },
    onPeerRejoined: ({ sendSnapshot }) => {
      if (game && game.mode === 'online' && game.isHost) {
        sendSnapshot({
          type: 'state_sync',
          forceImmediate: true,
          ...game.buildSyncSnapshot(),
        });
      }
    },
    onPeerLeft: ({ slot, isHost }) => {
      stepSimulation(performance.now());
      if (game && game.mode === 'online') {
        game.isHost = Boolean(isHost);
        if (slot >= 1 && slot <= game.playerData.length) {
          game.playerData[slot - 1].type = 'ai';
          if (game.tanks[slot - 1]) {
            game.tanks[slot - 1].type = 'ai';
            game.tanks[slot - 1].dif = 'normal';
            game.tanks[slot - 1].firstFrame = true;
          }
        }
      }
    },
    onError: (message) => showLobbyError(message),
  });

  // ==================== MID-GAME SAVES MODAL ====================

  function showSavesStatus(msg, isErr = false) {
    savesStatus.textContent = msg || '';
    savesStatus.className = 'info-banner' + (isErr ? ' err' : '');
    savesStatus.hidden = !msg;
  }

  function formatSaveTime(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function exportSaveFile(save) {
    const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tank3000-round${save.gameRound || 1}-${(save.id || 'save').slice(-6)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  let savesOpenedFromLobby = false;

  function resumeSaveEntry(save) {
    try {
      if (savesOpenedFromLobby && net.lobby && net.lobby.isHost && !net.lobby.inMatch) {
        net.hostConfig('set_loaded_save', { save });
        savesModal.hidden = true;
        lobbyModal.hidden = false;
        savesOpenedFromLobby = false;
        return;
      }

      if (game.mode === 'online' && game.isHost) {
        if (save.playerData.length !== game.playerData.length) {
          showSavesStatus(
            `This save has ${save.playerData.length} players, while your current online match has ${game.playerData.length}. Leave to the Online Lobby and use "Load Save" to resume it with friends.`,
            true
          );
          return;
        }
        game.loadSaveData(save, { mode: 'online', mySlot: game.mySlot, isHost: true });
        net.sendAction({
          type: 'state_sync',
          forceImmediate: true,
          ...game.buildSyncSnapshot(),
        });
        savesModal.hidden = true;
        return;
      }

      if (net.roomCode) net.leaveRoom();
      lobbyModal.hidden = true;
      savesModal.hidden = true;
      game.loadSaveData(save, { mode: 'local' });
    } catch (err) {
      showSavesStatus(err?.message || 'Could not load save.', true);
    }
  }

  function renderSavesModal() {
    showSavesStatus('');
    const inOnlineLobbyHost = savesOpenedFromLobby && net.lobby && net.lobby.isHost && !net.lobby.inMatch;
    const inOnlineGuest = game.mode === 'online' && !game.isHost;
    const canSaveNow = game.canSaveGame() && !inOnlineLobbyHost;

    btnSaveNow.disabled = !canSaveNow;
    saveNameInput.disabled = !canSaveNow;
    if (inOnlineLobbyHost) {
      saveNowHint.textContent = 'Select a saved match below to load it into your online lobby so friends can join and resume together.';
    } else if (canSaveNow) {
      saveNowHint.textContent = `Ready to save Round ${game.gameRound} (${game.scene === 'shop' ? 'Shop' : 'Battle'}). Auto-save also updates every turn.`;
    } else {
      saveNowHint.textContent = 'Start a match (or wait for the current shot/explosion to finish) to create a new save.';
    }

    savesListEl.innerHTML = '';
    const auto = readAutoSave();
    const manuals = readManualSaves();
    const allEntries = [];
    if (auto) allEntries.push({ isAuto: true, save: auto });
    for (const s of manuals) allEntries.push({ isAuto: false, save: s });

    if (!allEntries.length) {
      const empty = document.createElement('div');
      empty.className = 'saves-empty';
      empty.textContent = 'No saved matches yet. Start playing to auto-save every turn, or import a .json save file.';
      savesListEl.appendChild(empty);
      return;
    }

    const actionLabel = inOnlineLobbyHost
      ? 'Load in Room'
      : (game.mode === 'online' && game.isHost ? 'Sync Restore' : 'Resume');

    allEntries.forEach(({ isAuto, save }) => {
      const card = document.createElement('div');
      card.className = 'save-card' + (isAuto ? ' autosave' : '');

      const meta = document.createElement('div');
      meta.className = 'save-meta';

      const title = document.createElement('div');
      title.className = 'save-title';
      const titleText = document.createElement('span');
      titleText.textContent = isAuto ? 'Auto-Save' : (save.label || `Round ${save.gameRound || 1}`);
      title.appendChild(titleText);

      const roundTag = document.createElement('span');
      roundTag.className = 'save-tag';
      roundTag.textContent = `R${save.gameRound || 1} · ${save.scene === 'shop' ? 'Shop' : 'Battle'}`;
      title.appendChild(roundTag);

      if (save.balancePreset === 'classic') {
        const modeTag = document.createElement('span');
        modeTag.className = 'save-tag classic';
        modeTag.textContent = 'Classic';
        title.appendChild(modeTag);
      }

      const sub = document.createElement('div');
      sub.className = 'save-sub';
      const scoreSummary = (save.playerData || [])
        .map((p) => `${p.name} (${Math.round(p.total_score || 0)})`)
        .join(' · ');
      const when = formatSaveTime(save.savedAt);
      sub.textContent = when ? `${when} — ${scoreSummary}` : scoreSummary;

      meta.append(title, sub);

      const actions = document.createElement('div');
      actions.className = 'save-actions';

      const btnRes = document.createElement('button');
      btnRes.type = 'button';
      btnRes.className = 'pc-btn primary sm';
      btnRes.textContent = actionLabel;
      if (inOnlineGuest) {
        btnRes.title = 'Resuming will leave your current online room and continue locally';
      }
      btnRes.addEventListener('click', () => resumeSaveEntry(save));
      actions.appendChild(btnRes);

      const btnExp = document.createElement('button');
      btnExp.type = 'button';
      btnExp.className = 'pc-btn ghost sm';
      btnExp.textContent = 'Export';
      btnExp.addEventListener('click', () => exportSaveFile(save));
      actions.appendChild(btnExp);

      if (!isAuto) {
        const btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.className = 'btn-mini';
        btnDel.textContent = '×';
        btnDel.title = 'Delete save';
        btnDel.addEventListener('click', () => {
          const next = readManualSaves().filter((x) => x.id !== save.id);
          writeManualSaves(next);
          renderSavesModal();
        });
        actions.appendChild(btnDel);
      }

      card.append(meta, actions);
      savesListEl.appendChild(card);
    });
  }

  // ==================== INSTANTIATE TANKGAME ====================

  let weaponDrawerOpen = false;
  let shieldPopoverOpen = false;

  function closePopovers() {
    weaponDrawerOpen = false;
    shieldPopoverOpen = false;
    weaponDrawer.hidden = true;
    shieldPopover.hidden = true;
  }

  game = new TankGame(renderer, sound, {
    onOnlineAim: (payload) => net.sendAim(payload),
    onOnlineAction: (payload) => net.sendAction(payload),
    onOnlineShopBuy: ({ slot, kind, index }) => net.sendShopBuy(slot, kind, index),
    onOnlineShopReady: () => net.sendShopReady(),
    onAutoSave: (save) => writeAutoSave(save),
    onStatusChange: () => {
      closePopovers();
      refreshResyncButtons();
      refreshAwayButton();
      refreshTitleContinueBtn();
      lastShopSig = '';
      lastDrawerSig = '';
      lastShieldSig = '';
      lastScoreSig = '';
    },
  });

  window.__TANK3000__ = { game, renderer, sound, net };
  renderLocalSetupPlayers();
  refreshTitleContinueBtn();

  // ==================== POPOVER & SHOP RENDERERS ====================

  let lastDrawerSig = '';
  let lastShieldSig = '';
  let lastScoreSig = '';
  let lastShopSig = '';

  function renderWeaponDrawer(t) {
    if (!t) return;
    const pd = t.data;
    const sig = `${t.tankNumber}|${pd.cur_gun}|${pd.guns.join(',')}`;
    if (sig === lastDrawerSig) return;
    lastDrawerSig = sig;

    weaponDrawerGrid.innerHTML = '';
    WEAPONS.forEach((w, idx) => {
      const count = idx === 0 ? 99 : pd.guns[idx];
      if (count <= 0) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'weapon-option' + (pd.cur_gun === idx ? ' is-selected' : '');
      btn.innerHTML = `
        <span class="weapon-svg-slot">${getWeaponSvg(w)}</span>
        <span class="wo-name">${w.name}</span>
        <span class="ammo-badge tabular">${idx === 0 ? '∞' : count}</span>
      `;
      btn.addEventListener('click', () => {
        game.selectWeapon(idx);
        closePopovers();
      });
      weaponDrawerGrid.appendChild(btn);
    });
  }

  function renderShieldPopover(t) {
    if (!t) return;
    const pd = t.data;
    const sig = `${t.tankNumber}|${t.shActive}|${t.shieldUsedThisRound}|${pd.specials.slice(3, 7).join(',')}`;
    if (sig === lastShieldSig) return;
    lastShieldSig = sig;

    shieldPopoverNote.textContent = t.shieldUsedThisRound
      ? 'Used this round'
      : (t.shActive ? `Active (${Math.round(t.shieldEnergy)} HP)` : '1 per round');

    shieldPopoverList.innerHTML = '';
    const tierNames = ['', 'Weak', 'Standard', 'Strong', 'Super'];
    for (let tier = 1; tier <= 4; tier++) {
      const info = SHIELD_TIERS[tier];
      const count = pd.specials[info.specialIdx] || 0;
      const disabled = count <= 0 || t.shActive || t.shieldUsedThisRound;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shield-tier-btn';
      btn.disabled = disabled;
      btn.innerHTML = `
        <span class="st-name">${tierNames[tier]}</span>
        <span class="st-hp tabular">${info.maxEnergy} HP</span>
        <span class="st-cnt tabular">×${count}</span>
      `;
      btn.addEventListener('click', () => {
        game.activateShield(tier);
        closePopovers();
      });
      shieldPopoverList.appendChild(btn);
    }

    if (t.shActive) {
      const offBtn = document.createElement('button');
      offBtn.type = 'button';
      offBtn.className = 'pc-btn ghost sm shield-off-btn';
      offBtn.textContent = 'Disable Active Shield';
      offBtn.addEventListener('click', () => {
        game.disableShield();
        closePopovers();
      });
      shieldPopoverList.appendChild(offBtn);
    }
  }

  function renderScoreboard() {
    const activeNum = game.activeTank ? game.activeTank.tankNumber : 0;
    const ranked = [...game.playerData].sort((a, b) => b.total_score - a.total_score || a.t_num - b.t_num);
    const sig = ranked.map((p) => `${p.t_num}:${Math.round(p.total_score)}:${p.live ? 1 : 0}:${p.t_num === activeNum ? 1 : 0}`).join('|');
    if (sig === lastScoreSig) return;
    lastScoreSig = sig;

    hudScoreboard.innerHTML = '';
    for (const p of ranked) {
      const row = document.createElement('div');
      row.className = 'sb-row' + (p.t_num === activeNum ? ' is-active' : '') + (!p.live ? ' is-dead' : '');
      row.innerHTML = `
        <span class="sb-left">
          <span class="sb-dot" style="background:${hexIntToCss(p.col)}"></span>
          <span class="sb-name"></span>
        </span>
        <span class="sb-score tabular">${Math.round(p.total_score).toLocaleString()}</span>
      `;
      row.querySelector('.sb-name').textContent = p.name;
      hudScoreboard.appendChild(row);
    }
  }

  function renderShop() {
    if (game.scene !== 'shop') return;
    const pd = game.playerData[game.shopCur - 1];
    if (!pd) return;

    const caption = game.getShopButtonCaption();
    const locked = game.mode === 'online' && game.onlineReadySent;
    const toastTxt = game.bannerToast ? game.bannerToast.text : '';
    const sig = [
      game.gameRound,
      game.shopCur,
      Math.round(pd.score),
      pd.guns.join(','),
      pd.specials.join(','),
      caption,
      locked ? 1 : 0,
      toastTxt,
    ].join('|');

    if (sig === lastShopSig) return;
    lastShopSig = sig;

    shopPlayerDot.style.background = hexIntToCss(pd.col);
    shopPlayerName.textContent = `${pd.name}'s Armory`;
    shopRoundBadge.textContent = `Round ${game.gameRound} Complete`;
    shopCashVal.textContent = `$${Math.round(pd.score).toLocaleString()}`;

    if (toastTxt) {
      shopToast.hidden = false;
      shopToast.textContent = toastTxt;
    } else {
      shopToast.hidden = true;
    }

    // Weapons column (buyable weapons 1..13)
    shopWeaponsList.innerHTML = '';
    for (let i = 1; i < WEAPONS.length; i++) {
      const w = WEAPONS[i];
      const afford = !locked && pd.score >= w.price;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shop-row';
      btn.disabled = !afford;
      btn.innerHTML = `
        <span class="weapon-svg-slot">${getWeaponSvg(w)}</span>
        <span class="shop-row-name">${w.name}</span>
        <span class="shop-pack tabular">+${w.pack}</span>
        <span class="shop-owned tabular">×${pd.guns[i]}</span>
        <span class="shop-price tabular ${afford ? '' : 'cant-afford'}">$${w.price.toLocaleString()}</span>
      `;
      btn.addEventListener('click', () => {
        if (game.applyShopPurchase(game.shopCur, 'weapon', i)) {
          lastShopSig = '';
          renderShop();
        }
      });
      shopWeaponsList.appendChild(btn);
    }

    // Defenses & Upgrades column (all 12 specials)
    shopSpecialsList.innerHTML = '';
    for (let i = 0; i < SPECIALS.length; i++) {
      const s = SPECIALS[i];
      const owned = pd.specials[i] || 0;
      const maxed = Boolean(s.maxLevel && owned >= s.maxLevel);
      const afford = !locked && !maxed && pd.score >= s.price;

      let ownedHtml;
      if (s.maxLevel) {
        let pips = '';
        for (let lv = 1; lv <= s.maxLevel; lv++) {
          pips += `<span class="upgrade-pip${lv <= owned ? ' filled' : ''}"></span>`;
        }
        ownedHtml = `<span class="upgrade-pips" title="Level ${owned}/${s.maxLevel}">${pips}</span>`;
      } else {
        ownedHtml = `<span class="shop-owned tabular">×${owned}</span>`;
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shop-row';
      btn.disabled = !afford;
      btn.innerHTML = `
        <span class="weapon-svg-slot">${getSpecialSvg(i)}</span>
        <span class="shop-row-name">${s.name}</span>
        <span class="shop-pack tabular">+${s.pack}</span>
        ${ownedHtml}
        <span class="shop-price tabular ${maxed ? 'is-max' : (afford ? '' : 'cant-afford')}">${maxed ? 'MAX' : '$' + s.price.toLocaleString()}</span>
      `;
      btn.addEventListener('click', () => {
        if (game.applyShopPurchase(game.shopCur, 'special', i)) {
          lastShopSig = '';
          renderShop();
        }
      });
      shopSpecialsList.appendChild(btn);
    }

    // Compact Scoreboard strip
    const ranked = [...game.playerData].sort((a, b) => b.total_score - a.total_score || a.t_num - b.t_num);
    shopScoreboard.innerHTML = '';
    for (const p of ranked) {
      const chip = document.createElement('span');
      chip.className = 'score-chip' + (p.t_num === pd.t_num ? ' is-current' : '');
      chip.innerHTML = `<span class="sb-dot" style="background:${hexIntToCss(p.col)}"></span><span class="sc-name"></span><strong class="tabular">${Math.round(p.total_score).toLocaleString()}</strong>`;
      chip.querySelector('.sc-name').textContent = p.name;
      shopScoreboard.appendChild(chip);
    }

    btnShopNext.textContent = caption;
    btnShopNext.disabled = locked;
  }

  // ==================== REACTIVE FRAME UI SYNC ====================

  let lastScene = '';
  let lastFfVis = null;
  let lastFfOn = null;
  let draggingAngleSlider = false;
  let draggingPowerSlider = false;

  function syncUI() {
    const sc = game.scene;
    if (sc !== lastScene) {
      lastScene = sc;
      screenTitle.hidden = sc !== 'menu1';
      screenLocalSetup.hidden = sc !== 'menu2';
      hudBattle.hidden = sc !== 'battle';
      screenShop.hidden = sc !== 'shop';
      menuUtilBar.hidden = sc === 'battle';
      btnMenuHome.hidden = !(sc === 'shop');
      btnMenuSaves.hidden = !(sc === 'shop');
      refreshResyncButtons();
    }

    if (sc === 'shop') {
      renderShop();
      return;
    }

    if (sc !== 'battle') return;

    const t = game.activeTank || game.nextTank || game.tanks[0];
    if (!t) return;
    const pd = t.data;
    const localCtrl = game.canLocalControl();
    const maxPow = getMaxPower(pd.energy);

    // Top-Left Active Player Pill
    hudPlayerDot.style.background = hexIntToCss(pd.col);
    hudPlayerName.textContent = pd.name;
    const hpPct = Math.max(0, Math.min(100, (pd.energy / Math.max(1, pd.max_energy)) * 100));
    hudHpFill.style.width = `${hpPct}%`;
    hudHpFill.style.background = hpPct > 55 ? '#16a34a' : hpPct > 28 ? '#d97706' : '#dc2626';
    hudHpText.textContent = `${Math.round(pd.energy)}`;

    if (t.shActive && t.shieldEnergy > 0) {
      hudShieldChip.hidden = false;
      hudShieldVal.textContent = `${Math.round(t.shieldEnergy)}`;
    } else {
      hudShieldChip.hidden = true;
    }
    hudCash.textContent = `$${Math.round(pd.score).toLocaleString()}`;

    // Top-Center Round, Wind, Timer, Sudden Death, 4x
    hudRound.textContent = `R${game.gameRound}`;
    const wind = Math.round(game.terrain.vitr);
    hudWindVal.textContent = String(Math.abs(wind));
    hudWindArrow.textContent = wind > 1 ? '→' : wind < -1 ? '←' : '·';
    const windPct = Math.min(50, (Math.abs(wind) / 100) * 50);
    if (wind >= 0) {
      hudWindBar.style.left = '50%';
      hudWindBar.style.width = `${windPct}%`;
    } else {
      hudWindBar.style.left = `${50 - windPct}%`;
      hudWindBar.style.width = `${windPct}%`;
    }

    if (game.turnTimerSec > 0 && game.activeTank && game.activeTank.type === 'tank' && game.activeTank.playing) {
      const secs = Math.max(0, Math.ceil(game.turnTicksLeft / FPS));
      hudTimerBadge.hidden = false;
      hudTimerBadge.textContent = `⏱ ${secs}s`;
      hudTimerBadge.classList.toggle('urgent', secs <= 5);
    } else {
      hudTimerBadge.hidden = true;
    }

    const dmgMult = game.getDamageMultiplier();
    if (dmgMult > 1) {
      hudSdBadge.hidden = false;
      hudSdBadge.textContent = `${dmgMult.toFixed(1)}× DMG`;
    } else {
      hudSdBadge.hidden = true;
    }

    const canShowFf = game.isBotsOnlyAlive() && (game.mode === 'local' || game.isHost);
    const ffOn = Boolean(game.fastForward && canShowFf);
    hudFfBadge.hidden = !ffOn;
    if (canShowFf !== lastFfVis) {
      lastFfVis = canShowFf;
      btnFastForward.hidden = !canShowFf;
    }
    if (ffOn !== lastFfOn) {
      lastFfOn = ffOn;
      btnFastForward.textContent = ffOn ? '⏩ 4× Speed ON' : '⏩ Skip Bots (4×)';
      btnFastForward.classList.toggle('is-on', ffOn);
    }

    // Event / Targeting / Waiting Banner
    let bannerText = '';
    let bannerColor = '#0284c7';
    if (game.teleport && !game.teleport.picked && game.canLocalControlSpecialOverlay()) {
      bannerText = 'TELEPORT · Click anywhere on the map to relocate';
      bannerColor = '#0284c7';
    } else if (game.airStrike && !game.airStrike.launched && game.canLocalControlSpecialOverlay()) {
      bannerText = 'AIR STRIKE · Click target zone (← / → flips plane direction)';
      bannerColor = '#dc2626';
    } else if (onlineStatusBanner) {
      bannerText = onlineStatusBanner;
      bannerColor = '#d97706';
    } else if (game.bannerToast) {
      bannerText = game.bannerToast.text;
      bannerColor = game.bannerToast.color || '#0284c7';
    } else if (game.mode === 'online' && game.activeTank && game.activeTank.playing) {
      const isMine = game.activeTank.type === 'tank' && game.activeTank.tankNumber === game.mySlot;
      if (!isMine) {
        bannerText = `Waiting for ${pd.name}...`;
        bannerColor = '#64748b';
      }
    }

    if (bannerText) {
      hudBanner.hidden = false;
      hudBanner.textContent = bannerText;
      hudBanner.style.borderColor = bannerColor;
    } else {
      hudBanner.hidden = true;
    }

    // Top-Right Scoreboard
    renderScoreboard();

    // Bottom Command Dock auto-dimming when shots fly or non-local turn
    commandDock.classList.toggle('is-dimmed', !localCtrl);
    if (!localCtrl && (weaponDrawerOpen || shieldPopoverOpen)) {
      closePopovers();
    }

    // Dock values
    dockFuelVal.textContent = String(Math.round(pd.fuel));
    btnDriveLeft.disabled = !localCtrl || pd.fuel <= 0;
    btnDriveRight.disabled = !localCtrl || pd.fuel <= 0;

    const ang = Math.round(t.rotace);
    dockAngleVal.textContent = `${ang}°`;
    if (!draggingAngleSlider) {
      dockAngleSlider.value = String(ang);
    }

    const pow = Math.round(t.power);
    dockPowerVal.textContent = String(pow);
    dockMaxpowCap.textContent = maxPow < 100 ? `/${maxPow}` : '';
    if (!draggingPowerSlider) {
      dockPowerSlider.value = String(pow);
    }
    if (maxPow < 100) {
      dockPowerLock.hidden = false;
      dockPowerLock.style.width = `${100 - maxPow}%`;
    } else {
      dockPowerLock.hidden = true;
    }

    const curW = WEAPONS[pd.cur_gun] || WEAPONS[0];
    dockWeaponName.textContent = curW.name;
    dockWeaponAmmo.textContent = pd.cur_gun === 0 ? '∞' : String(pd.guns[pd.cur_gun] ?? 0);
    if (dockWeaponIcon.dataset.wid !== String(curW.id)) {
      dockWeaponIcon.dataset.wid = String(curW.id);
      dockWeaponIcon.innerHTML = getWeaponSvg(curW);
    }

    // Specials counts & enabled states
    spRepairCnt.textContent = String(pd.specials[1] || 0);
    btnSpRepair.disabled = !localCtrl || pd.specials[1] <= 0 || pd.energy >= pd.max_energy;

    spParaCnt.textContent = String(pd.specials[0] || 0);
    btnSpPara.disabled = !localCtrl || pd.specials[0] <= 0;
    btnSpPara.classList.toggle('is-armed', Boolean(t.par && pd.specials[0] > 0));

    const totalShields = (pd.specials[3] || 0) + (pd.specials[4] || 0) + (pd.specials[5] || 0) + (pd.specials[6] || 0);
    spShieldCnt.textContent = String(totalShields);
    btnSpShield.disabled = !localCtrl || (!t.shActive && (totalShields <= 0 || t.shieldUsedThisRound));
    btnSpShield.classList.toggle('is-armed', Boolean(t.shActive));

    spTeleCnt.textContent = String(pd.specials[7] || 0);
    btnSpTele.disabled = !localCtrl || pd.specials[7] <= 0;

    btnFire.disabled = !localCtrl;

    if (weaponDrawerOpen) renderWeaponDrawer(t);
    if (shieldPopoverOpen) renderShieldPopover(t);
  }

  // ==================== COMMAND DOCK INTERACTIONS ====================

  // Hold-to-drive buttons
  function bindHoldDrive(btn, dir) {
    const start = (ev) => {
      ev.preventDefault();
      sound.unlock();
      game.setFuelMove(dir);
    };
    const stop = () => game.setFuelMove(0);
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
  }
  bindHoldDrive(btnDriveLeft, -1);
  bindHoldDrive(btnDriveRight, 1);

  dockAngleSlider.addEventListener('pointerdown', () => { draggingAngleSlider = true; sound.unlock(); });
  dockAngleSlider.addEventListener('pointerup', () => { draggingAngleSlider = false; });
  dockAngleSlider.addEventListener('change', () => { draggingAngleSlider = false; });
  dockAngleSlider.addEventListener('input', () => {
    game.setAngle(Number(dockAngleSlider.value));
  });

  dockPowerSlider.addEventListener('pointerdown', () => { draggingPowerSlider = true; sound.unlock(); });
  dockPowerSlider.addEventListener('pointerup', () => { draggingPowerSlider = false; });
  dockPowerSlider.addEventListener('change', () => { draggingPowerSlider = false; });
  dockPowerSlider.addEventListener('input', () => {
    const t = game.activeTank;
    const cap = t ? getMaxPower(t.data.energy) : 100;
    const v = Math.min(cap, Number(dockPowerSlider.value));
    dockPowerSlider.value = String(v);
    game.setPower(v);
  });

  btnWeaponPrev.addEventListener('click', () => { sound.unlock(); game.cycleWeapon(-1); });
  btnWeaponNext.addEventListener('click', () => { sound.unlock(); game.cycleWeapon(1); });

  btnWeaponDrawer.addEventListener('click', () => {
    sound.unlock();
    if (!game.canLocalControl()) return;
    shieldPopoverOpen = false;
    shieldPopover.hidden = true;
    weaponDrawerOpen = !weaponDrawerOpen;
    weaponDrawer.hidden = !weaponDrawerOpen;
    if (weaponDrawerOpen) {
      lastDrawerSig = '';
      renderWeaponDrawer(game.activeTank);
    }
  });

  btnSpRepair.addEventListener('click', () => { sound.unlock(); game.useRepair(); });
  btnSpPara.addEventListener('click', () => { sound.unlock(); game.toggleParachute(); });
  btnSpTele.addEventListener('click', () => { sound.unlock(); closePopovers(); game.beginTeleport(); });
  btnSpShield.addEventListener('click', () => {
    sound.unlock();
    if (!game.canLocalControl()) return;
    weaponDrawerOpen = false;
    weaponDrawer.hidden = true;
    shieldPopoverOpen = !shieldPopoverOpen;
    shieldPopover.hidden = !shieldPopoverOpen;
    if (shieldPopoverOpen) {
      lastShieldSig = '';
      renderShieldPopover(game.activeTank);
    }
  });

  btnFire.addEventListener('click', () => {
    sound.unlock();
    closePopovers();
    game.fireCurrentTank();
  });

  btnShopNext.addEventListener('click', () => {
    sound.unlock();
    game.shopNext();
  });

  // ==================== TITLE & LOCAL SETUP BUTTONS ====================

  btnTitleLocal.addEventListener('click', () => {
    sound.unlock();
    game.openLocalSetup();
  });

  btnTitleOnline.addEventListener('click', () => {
    sound.unlock();
    showLobbyError('');
    savesModal.hidden = true;
    lobbyModal.hidden = false;
  });

  btnTitleContinue.addEventListener('click', () => {
    sound.unlock();
    const auto = readAutoSave();
    if (auto) resumeSaveEntry(auto);
  });

  const openSavesModal = () => {
    sound.unlock();
    savesOpenedFromLobby = false;
    renderSavesModal();
    savesModal.hidden = false;
  };
  btnTitleSaves.addEventListener('click', openSavesModal);
  btnMenuSaves.addEventListener('click', openSavesModal);
  btnHudSaves.addEventListener('click', openSavesModal);

  const toggleControlsModal = () => {
    controlsModal.hidden = !controlsModal.hidden;
  };
  btnTitleControls.addEventListener('click', toggleControlsModal);
  btnMenuControls.addEventListener('click', toggleControlsModal);
  btnHudControls.addEventListener('click', toggleControlsModal);

  const toggleSoundMute = () => {
    const muted = sound.toggleMute();
    const glyph = muted ? '🔇' : '🔊';
    btnMenuMute.textContent = glyph;
    btnMenuMute.classList.toggle('active-muted', muted);
    btnHudMute.textContent = glyph;
    btnHudMute.classList.toggle('active-muted', muted);
  };
  btnMenuMute.addEventListener('click', toggleSoundMute);
  btnHudMute.addEventListener('click', toggleSoundMute);

  const returnToTitle = () => {
    net.leaveRoom();
    lobbyModal.hidden = true;
    savesModal.hidden = true;
    closePopovers();
    game.resetToTitle();
  };
  btnMenuHome.addEventListener('click', returnToTitle);
  btnHudMenu.addEventListener('click', returnToTitle);
  btnHudOnline.addEventListener('click', () => {
    sound.unlock();
    showLobbyError('');
    savesModal.hidden = true;
    lobbyModal.hidden = false;
  });

  // Local Setup controls
  btnSetupBack.addEventListener('click', () => game.resetToTitle());

  setupTerrainEl.addEventListener('change', () => {
    game.setTitlePreviewBiome(Number(setupTerrainEl.value));
  });

  btnSetupAddPlayer.addEventListener('click', () => {
    if (setupPlayers.length >= 5) return;
    const n = setupPlayers.length + 1;
    const usedCols = new Set(setupPlayers.map((p) => p.col));
    const freeCol = PLAYER_COLORS.find((c) => !usedCols.has(c)) ?? PLAYER_COLORS[(n - 1) % PLAYER_COLORS.length];
    setupPlayers.push({ name: `Bot ${n}`, col: freeCol, type: 'ai', dif: 'normal' });
    renderLocalSetupPlayers();
  });

  btnSetupStart.addEventListener('click', () => {
    sound.unlock();
    game.startLocalMatch({
      krajina: Number(setupTerrainEl.value),
      preset: setupPresetEl.value,
      turnTimer: Number(setupTimerEl.value),
      players: setupPlayers,
    });
  });

  // ==================== ONLINE INVITE URL & LOBBY WIRING ====================

  const urlParams = new URLSearchParams(location.search);
  const urlMode = urlParams.get('mode');
  if (urlMode === 'ws' || urlMode === 'p2p') {
    selectTransport.value = urlMode;
    net.setTransport(urlMode);
  }
  function updateTransportHint() {
    net.setTransport(selectTransport.value);
    if (selectTransport.value === 'p2p') {
      lobbyHint.innerHTML =
        '<strong>Online P2P</strong> connects browsers directly via WebRTC — works on GitHub Pages, Netlify, Cloudflare Pages, or locally with zero backend server. Create a room and send the invite link or 4-letter code to friends.';
    } else {
      lobbyHint.innerHTML =
        '<strong>Local / LAN Server</strong> connects via WebSocket to <code>python server.py</code> running on your network. Best for offline LAN play.';
    }
  }
  selectTransport.addEventListener('change', updateTransportHint);
  updateTransportHint();

  const urlRoom = urlParams.get('room');
  const lastRoom = getLastRoomSession();
  if (urlRoom) {
    inputCode.value = urlRoom.toUpperCase();
    if (lastRoom?.name) inputName.value = lastRoom.name;
    lobbyModal.hidden = false;
  } else if (lastRoom) {
    if (lastRoom.code) inputCode.value = lastRoom.code;
    if (lastRoom.name) inputName.value = lastRoom.name;
  }

  btnLobbyLoadSave.addEventListener('click', () => {
    savesOpenedFromLobby = true;
    renderSavesModal();
    savesModal.hidden = false;
  });

  btnClearLobbySave.addEventListener('click', () => {
    net.hostConfig('clear_loaded_save');
  });

  btnSaveNow.addEventListener('click', () => {
    if (!game.canSaveGame()) {
      showSavesStatus('Wait until the current shot finishes before saving.', true);
      return;
    }
    const save = game.buildSaveData(saveNameInput.value.trim());
    const list = readManualSaves();
    list.unshift(save);
    writeManualSaves(list);
    saveNameInput.value = '';
    renderSavesModal();
    showSavesStatus(`Saved "${save.label}"!`);
  });

  btnImportSave.addEventListener('click', () => {
    importSaveFile.value = '';
    importSaveFile.click();
  });

  importSaveFile.addEventListener('change', async () => {
    const file = importSaveFile.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.playerData) || parsed.playerData.length < 2) {
        throw new Error('Not a valid Tank 3000 save file.');
      }
      parsed.id = `save-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      parsed.savedAt = parsed.savedAt || Date.now();
      const list = readManualSaves();
      list.unshift(parsed);
      writeManualSaves(list);
      renderSavesModal();
      showSavesStatus(`Imported "${parsed.label || file.name}"!`);
    } catch (err) {
      showSavesStatus(err?.message || 'Could not import save file.', true);
    }
  });

  document.querySelectorAll('[data-close-modal]').forEach((el) => {
    el.addEventListener('click', () => {
      const modal = el.closest('.modal-backdrop');
      if (modal) {
        modal.hidden = true;
        if (modal === savesModal) savesOpenedFromLobby = false;
      } else {
        controlsModal.hidden = true;
        lobbyModal.hidden = true;
        savesModal.hidden = true;
        savesOpenedFromLobby = false;
      }
    });
  });

  function setLobbyBusy(busy) {
    btnCreateRoom.disabled = busy;
    btnJoinRoom.disabled = busy;
    selectTransport.disabled = busy;
  }

  btnCreateRoom.addEventListener('click', async () => {
    showLobbyError('');
    setLobbyBusy(true);
    try {
      net.setTransport(selectTransport.value);
      await net.createRoom(inputName.value.trim() || 'Player 1');
    } catch (err) {
      showLobbyError(err?.message || 'Could not create room.');
    } finally {
      setLobbyBusy(false);
    }
  });

  btnJoinRoom.addEventListener('click', async () => {
    showLobbyError('');
    const code = inputCode.value.trim().toUpperCase();
    if (!code) {
      showLobbyError('Enter a 4-character room code.');
      return;
    }
    setLobbyBusy(true);
    try {
      net.setTransport(selectTransport.value);
      await net.joinRoom(code, inputName.value.trim() || 'Player');
    } catch (err) {
      showLobbyError(err?.message || `Could not join room '${code}'.`);
    } finally {
      setLobbyBusy(false);
    }
  });

  document.getElementById('btn-leave-room').addEventListener('click', () => {
    net.leaveRoom();
    lobbyRoom.hidden = true;
    lobbyEntry.hidden = false;
  });

  roomTerrainEl.addEventListener('change', () => {
    net.hostConfig('set_krajina', { krajina: Number(roomTerrainEl.value) });
  });

  roomPresetEl.addEventListener('change', () => {
    net.hostConfig('set_preset', { preset: roomPresetEl.value });
  });

  roomTimerEl.addEventListener('change', () => {
    net.hostConfig('set_turn_timer', { turnTimer: Number(roomTimerEl.value) });
  });

  btnAddBot.addEventListener('click', () => net.hostConfig('add_bot'));
  btnStartOnline.addEventListener('click', () => {
    if (document.activeElement && document.activeElement.classList?.contains('slot-name-input')) {
      document.activeElement.blur();
    }
    net.startMatch();
  });

  btnCopyInvite.addEventListener('click', () => {
    const modeSuffix = net.transport === 'ws' ? '&mode=ws' : '';
    const url = `${location.origin}${location.pathname}?room=${net.roomCode || ''}${modeSuffix}`;
    navigator.clipboard?.writeText(url).then(() => {
      btnCopyInvite.textContent = 'Copied!';
      setTimeout(() => { btnCopyInvite.textContent = 'Copy Invite Link'; }, 1500);
    }).catch(() => {});
  });

  // ==================== CANVAS POINTER & KEYBOARD INPUT ====================

  function toStageCoords(ev) {
    const rect = canvas.getBoundingClientRect();
    const sx = (ev.clientX - rect.left - vp.offsetX) / vp.scale;
    const sy = (ev.clientY - rect.top - vp.offsetY) / vp.scale;
    return [sx, sy];
  }

  function updateCanvasCursor() {
    if (game.cursorHidden) canvas.style.cursor = 'none';
    else if (game.draggingAngle) canvas.style.cursor = 'grabbing';
    else if (game.hoveringTankAim) canvas.style.cursor = 'grab';
    else canvas.style.cursor = 'default';
  }

  canvas.addEventListener('pointermove', (ev) => {
    const [sx, sy] = toStageCoords(ev);
    game.handleMouseMove(sx, sy);
    updateCanvasCursor();
  });

  canvas.addEventListener('pointerdown', (ev) => {
    if (weaponDrawerOpen || shieldPopoverOpen) {
      closePopovers();
    }
    const [sx, sy] = toStageCoords(ev);
    game.handleMouseDown(sx, sy);
    if (game.draggingAngle) {
      canvas.setPointerCapture?.(ev.pointerId);
    }
    updateCanvasCursor();
  });

  canvas.addEventListener('pointerup', (ev) => {
    const [sx, sy] = toStageCoords(ev);
    game.handleMouseUp(sx, sy);
    updateCanvasCursor();
  });

  canvas.addEventListener('pointercancel', () => {
    if (game.draggingAngle) {
      game.draggingAngle = false;
      game.sound.stop(346);
      updateCanvasCursor();
    }
  });

  window.addEventListener('keydown', (ev) => {
    const inTextField =
      document.activeElement &&
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);

    if (ev.code === 'Escape') {
      if (!controlsModal.hidden) { controlsModal.hidden = true; return; }
      if (!savesModal.hidden) { savesModal.hidden = true; savesOpenedFromLobby = false; return; }
      if (!lobbyModal.hidden) { lobbyModal.hidden = true; return; }
      if (weaponDrawerOpen || shieldPopoverOpen) { closePopovers(); return; }
    }

    if (!lobbyModal.hidden || !controlsModal.hidden || !savesModal.hidden || inTextField) return;

    // Dedicated Fullscreen hotkey ('F')
    if (ev.code === 'KeyF' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      toggleFullscreen();
      return;
    }

    game.handleKeyDown(ev);
  });

  window.addEventListener('keyup', (ev) => {
    game.handleKeyUp(ev);
  });

  window.addEventListener('blur', () => game.clearKeys());

  // ==================== FIXED 25Hz GAME LOOP (WITH ONLINE BACKGROUND SYNC) ====================

  let lastTime = performance.now();
  let acc = 0;

  stepSimulation = function (now) {
    const elapsed = now - lastTime;
    if (elapsed <= 0) return;
    lastTime = now;
    const isOnline = game.mode === 'online';
    const speedMult = game.getSimSpeed();
    const maxDt = isOnline ? 30000 : 120;
    const maxSteps = isOnline ? 750 * speedMult : 5 * speedMult;
    acc += Math.min(maxDt, elapsed) * speedMult;
    let steps = 0;
    while (acc >= FRAME_MS && steps < maxSteps) {
      game.tick(vp.viewBounds);
      acc -= FRAME_MS;
      steps++;
      if (speedMult > 1 && game.getSimSpeed() === 1) {
        acc = 0;
        break;
      }
    }
    if (acc >= FRAME_MS * maxSteps) acc = 0;
  };

  // Unthrottled Web Worker ticker keeps online simulation (25Hz), host bots,
  // and WebRTC heartbeats running indefinitely even while tab is in the background.
  const onBackgroundTick = () => {
    net.backgroundHeartbeatTick();
    if (document.hidden && game.mode === 'online') {
      stepSimulation(performance.now());
    }
  };
  try {
    const workerSrc = `setInterval(() => postMessage(1), ${Math.round(FRAME_MS)});`;
    const blob = new Blob([workerSrc], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    const bgWorker = new Worker(workerUrl);
    URL.revokeObjectURL(workerUrl);
    bgWorker.onmessage = onBackgroundTick;
  } catch {
    setInterval(onBackgroundTick, 100);
  }

  const onTabResume = () => {
    if (!document.hidden) {
      stepSimulation(performance.now());
      net.handleVisibilityResume();
      refreshAwayButton();
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      onTabResume();
    } else {
      game.clearKeys();
    }
  });
  window.addEventListener('focus', onTabResume);
  window.addEventListener('online', onTabResume);
  window.addEventListener('pagehide', (ev) => {
    if (!ev.persisted) {
      net.notifyTabClosing();
    }
  });

  function loop(now) {
    stepSimulation(now);
    syncUI();

    // Full-viewport HiDPI Paper-Cut render (centered 550x400 arena + edge-to-edge world)
    ctx.setTransform(
      vp.scale * vp.dpr,
      0,
      0,
      vp.scale * vp.dpr,
      vp.offsetX * vp.dpr,
      vp.offsetY * vp.dpr
    );
    ctx.imageSmoothingEnabled = game.quality !== 'LOW';
    game.render(ctx, vp.viewBounds);

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

boot().catch((err) => {
  console.error('Boot error:', err);
  const el = document.getElementById('boot-status');
  if (el) {
    el.hidden = false;
    el.textContent = 'Load error: ' + err.message;
  }
});
