// Entry point: HiDPI responsive canvas (11:8 aspect ratio), 25Hz simulation loop, input & Online Lobby UI

import {
  STAGE_W, STAGE_H, FRAME_MS,
  PLAYER_COLORS, AI_DIFFICULTIES, AI_DIFFICULTY_LABELS,
} from './constants.js';
import { VectorRenderer } from './renderer.js';
import { SoundManager } from './audio.js';
import { TankGame } from './game.js';
import { NetworkClient } from './network.js';

const COLOR_HEX = PLAYER_COLORS.map((c) => '#' + c.toString(16).padStart(6, '0'));

async function boot() {
  const canvas = document.getElementById('game-canvas');
  const stageWrap = document.getElementById('stage-wrap');
  const ctx = canvas.getContext('2d');

  // Outer chrome controls
  const btnLocal = document.getElementById('btn-local');
  const btnOnline = document.getElementById('btn-online');
  const btnSaves = document.getElementById('btn-saves');
  const btnMute = document.getElementById('btn-mute');
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const btnControls = document.getElementById('btn-controls');
  const statusPill = document.getElementById('status-pill');
  const btnFastForward = document.getElementById('btn-fast-forward');
  const btnAwayBot = document.getElementById('btn-away-bot');
  const localRulesBar = document.getElementById('local-rules-bar');
  const localPresetEl = document.getElementById('local-preset');
  const localTimerEl = document.getElementById('local-timer');

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

  // HiDPI crisp vector scaling keeping 550x400 (11:8) coordinate space
  let scale = 1;
  function resizeCanvas() {
    const rect = stageWrap.getBoundingClientRect();
    const availW = Math.max(320, rect.width - 16);
    const availH = Math.max(240, rect.height - 16);
    scale = Math.min(availW / STAGE_W, availH / STAGE_H);
    const cssW = Math.floor(STAGE_W * scale);
    const cssH = Math.floor(STAGE_H * scale);
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  window.addEventListener('resize', resizeCanvas);
  new ResizeObserver(resizeCanvas).observe(stageWrap);
  resizeCanvas();

  // Load vector graphics & audio assets
  statusPill.textContent = 'Loading game assets...';
  const renderer = new VectorRenderer();
  const data = await renderer.load('assets/game-assets.json');
  const sound = new SoundManager();
  await sound.loadAll(data.sounds || {});

  let game = null;
  let net = null;

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

    // Preserve active name input state if a lobby update arrives while typing
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

      // Color swatches
      const swatches = document.createElement('div');
      swatches.className = 'slot-colors';
      PLAYER_COLORS.forEach((colInt, ci) => {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'color-dot' + (s.col === colInt ? ' active' : '');
        sw.style.background = COLOR_HEX[ci];
        const canEditColor = s.isMe || (lobby.isHost && s.kind === 'ai');
        sw.disabled = !canEditColor;
        sw.addEventListener('click', () => {
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
          rm.className = 'btn-mini danger';
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
          rm.className = 'btn-mini danger';
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

  let stepSimulation = () => {};
  let currentAwaySlots = [];

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

  btnAwayBot.addEventListener('click', () => {
    const slotNum = Number(btnAwayBot.dataset.slot || 0);
    if (slotNum > 0) net.replaceAwayWithBot(slotNum);
  });

  let _lastFfVis = null;
  let _lastFfOn = null;
  function refreshFastForwardButton() {
    if (!game) return;
    const canShow = game.isBotsOnlyAlive() && (game.mode === 'local' || game.isHost);
    const isOn = Boolean(game.fastForward && canShow);
    if (canShow !== _lastFfVis) {
      _lastFfVis = canShow;
      btnFastForward.hidden = !canShow;
    }
    if (isOn !== _lastFfOn) {
      _lastFfOn = isOn;
      btnFastForward.textContent = isOn ? '⏩ 4× Speed ON' : '⏩ Skip Bots (4×)';
      btnFastForward.classList.toggle('accent', isOn);
      btnFastForward.classList.toggle('warn', !isOn);
    }
  }

  btnFastForward.addEventListener('click', () => {
    if (!game) return;
    game.setFastForward(!game.fastForward);
    refreshFastForwardButton();
  });

  net = new NetworkClient({
    onConnectionChange: (ok) => {
      if (!ok && game && game.mode === 'online') {
        statusPill.textContent = `Reconnecting to ${net.roomCode || 'room'}...`;
      }
    },
    onAwaySlotsChange: (awayList) => {
      currentAwaySlots = awayList || [];
      refreshAwayButton();
    },
    onReconnecting: (isReconnecting) => {
      if (isReconnecting) {
        statusPill.textContent = `Reconnecting to ${net.roomCode || 'room'}...`;
      } else if (game && game.mode === 'online') {
        statusPill.textContent = `Online ${net.roomCode || ''} · R${game.gameRound}`;
      } else if (net.roomCode) {
        statusPill.textContent = `Room ${net.roomCode}`;
      }
    },
    onLobbyState: (lobby) => {
      renderLobby(lobby);
      statusPill.textContent = `Room ${lobby.code} (${lobby.slots.length}/5)`;
    },
    onLeftRoom: () => {
      lobbyRoom.hidden = true;
      lobbyEntry.hidden = false;
      currentAwaySlots = [];
      refreshAwayButton();
      statusPill.textContent = 'Local Mode';
    },
    onMatchStart: (msg) => {
      lobbyModal.hidden = true;
      savesModal.hidden = true;
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
      statusPill.textContent = `Online Room ${msg.code} · Round ${game.gameRound}`;
    },
    onRemoteAim: (payload) => {
      stepSimulation(performance.now());
      game.applyRemoteAim(payload);
    },
    onRemoteAction: (payload) => {
      stepSimulation(performance.now());
      game.applyRemoteAction(payload);
    },
    onShopStatus: ({ ready, total }) => {
      game.onlineReadyStatus = `Waiting (${ready}/${total})`;
    },
    onNextRound: ({ seed, round }) => {
      stepSimulation(performance.now());
      game.startOnlineNextRound(seed);
      statusPill.textContent = `Online Room ${net.roomCode || ''} · Round ${round}`;
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

  // ==================== MID-GAME SAVE STORAGE & UI ====================

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
      // 1. Host loading a save into an open online lobby
      if (savesOpenedFromLobby && net.lobby && net.lobby.isHost && !net.lobby.inMatch) {
        net.hostConfig('set_loaded_save', { save });
        savesModal.hidden = true;
        lobbyModal.hidden = false;
        savesOpenedFromLobby = false;
        return;
      }

      // 2. Host restoring mid-match inside an active online room (same player count)
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

      // 3. Local resume (leave any guest room if connected)
      if (net.roomCode) net.leaveRoom();
      lobbyModal.hidden = true;
      savesModal.hidden = true;
      game.loadSaveData(save, { mode: 'local' });
      localPresetEl.value = game.balancePreset;
      localTimerEl.value = String(game.turnTimerSec);
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
      btnRes.className = 'primary-btn small';
      btnRes.style.padding = '5px 9px';
      btnRes.style.fontSize = '11px';
      btnRes.textContent = actionLabel;
      if (inOnlineGuest) {
        btnRes.title = 'Resuming will leave your current online room and continue locally';
      }
      btnRes.addEventListener('click', () => resumeSaveEntry(save));
      actions.appendChild(btnRes);

      const btnExp = document.createElement('button');
      btnExp.type = 'button';
      btnExp.className = 'secondary-btn small';
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

  game = new TankGame(renderer, sound, {
    onOnlineAim: (payload) => net.sendAim(payload),
    onOnlineAction: (payload) => net.sendAction(payload),
    onOnlineShopBuy: ({ slot, kind, index }) => net.sendShopBuy(slot, kind, index),
    onOnlineShopReady: () => net.sendShopReady(),
    onAutoSave: (save) => writeAutoSave(save),
    onStatusChange: (st) => {
      localRulesBar.hidden = !(st.mode === 'local' && (st.scene === 'menu1' || st.scene === 'menu2'));
      if (st.mode === 'online') {
        statusPill.textContent = `Online ${net.roomCode || ''} · R${st.round}${st.activePlayer ? ' · ' + st.activePlayer : ''}`;
      } else {
        const map = {
          menu1: 'Local · Setup',
          menu2: 'Local · Players',
          loading: `Local · Round ${st.round}`,
          battle: `Local · R${st.round}${st.activePlayer ? ' · ' + st.activePlayer : ''}`,
          shop: `Local · Shop (R${st.round})`,
        };
        statusPill.textContent = map[st.scene] || 'Local Mode';
      }
    },
  });
  statusPill.textContent = 'Local · Setup';
  localRulesBar.hidden = false;

  // Expose for debugging
  window.__TANK3000__ = { game, renderer, sound, net };

  // Check URL ?room=XXXX (& optional ?mode=ws) for direct invite links
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
  if (urlRoom) {
    inputCode.value = urlRoom.toUpperCase();
    lobbyModal.hidden = false;
  }

  // ==================== CANVAS INPUT MAPPING ====================

  function toStageCoords(ev) {
    const rect = canvas.getBoundingClientRect();
    const sx = ((ev.clientX - rect.left) / rect.width) * STAGE_W;
    const sy = ((ev.clientY - rect.top) / rect.height) * STAGE_H;
    return [sx, sy];
  }

  canvas.addEventListener('pointermove', (ev) => {
    const [sx, sy] = toStageCoords(ev);
    game.handleMouseMove(sx, sy);
    canvas.style.cursor = game.cursorHidden ? 'none' : 'default';
  });

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture?.(ev.pointerId);
    const [sx, sy] = toStageCoords(ev);
    game.handleMouseDown(sx, sy);
  });

  canvas.addEventListener('pointerup', (ev) => {
    const [sx, sy] = toStageCoords(ev);
    game.handleMouseUp(sx, sy);
    canvas.style.cursor = game.cursorHidden ? 'none' : 'default';
  });

  window.addEventListener('keydown', (ev) => {
    // Don't hijack keys when typing in modal inputs
    if (!lobbyModal.hidden || !controlsModal.hidden || !savesModal.hidden) return;
    if (document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    game.handleKeyDown(ev);
  });

  window.addEventListener('keyup', (ev) => {
    game.handleKeyUp(ev);
  });

  window.addEventListener('blur', () => game.clearKeys());

  // ==================== OUTER BAR & MODAL WIRING ====================

  localPresetEl.addEventListener('change', () => {
    game.setBalancePreset(localPresetEl.value);
  });

  localTimerEl.addEventListener('change', () => {
    game.setTurnTimer(Number(localTimerEl.value));
  });

  btnSaves.addEventListener('click', () => {
    sound.unlock();
    savesOpenedFromLobby = false;
    renderSavesModal();
    savesModal.hidden = false;
  });

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

  btnLocal.addEventListener('click', () => {
    net.leaveRoom();
    lobbyModal.hidden = true;
    savesModal.hidden = true;
    game.resetToTitle();
  });

  btnOnline.addEventListener('click', () => {
    sound.unlock();
    showLobbyError('');
    savesModal.hidden = true;
    lobbyModal.hidden = false;
  });

  btnMute.addEventListener('click', () => {
    const muted = sound.toggleMute();
    btnMute.textContent = muted ? '🔇 Muted' : '🔊 Sound';
    btnMute.classList.toggle('active', muted);
  });

  btnFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  });

  btnControls.addEventListener('click', () => {
    controlsModal.hidden = !controlsModal.hidden;
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

  function setLobbyBusy(busy, label) {
    btnCreateRoom.disabled = busy;
    btnJoinRoom.disabled = busy;
    selectTransport.disabled = busy;
    if (busy && label) {
      statusPill.textContent = label;
    }
  }

  btnCreateRoom.addEventListener('click', async () => {
    showLobbyError('');
    setLobbyBusy(true, 'Creating room...');
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
    setLobbyBusy(true, `Joining ${code}...`);
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
    // Commit any in-progress inline name edit before starting
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

  // ==================== FIXED 25Hz GAME LOOP (WITH ONLINE BACKGROUND SYNC) ====================

  let lastTime = performance.now();
  let acc = 0;

  stepSimulation = function (now) {
    const elapsed = now - lastTime;
    if (elapsed <= 0) return;
    lastTime = now;
    const isOnline = game.mode === 'online';
    const speedMult = game.getSimSpeed(); // 4 when bots-only fast-forward is active, else 1
    // In local mode, clamp dt so backgrounding pauses play cleanly.
    // In online mode, step all missed 25Hz ticks so peers stay in deterministic lockstep.
    const maxDt = isOnline ? 30000 : 120;
    const maxSteps = isOnline ? 750 * speedMult : 5 * speedMult;
    acc += Math.min(maxDt, elapsed) * speedMult;
    let steps = 0;
    while (acc >= FRAME_MS && steps < maxSteps) {
      game.tick();
      acc -= FRAME_MS;
      steps++;
      // Drop smoothly back to 1x the instant the bot-only battle finishes
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
    refreshFastForwardButton();

    // HiDPI crisp vector render
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    ctx.imageSmoothingEnabled = game.quality !== 'LOW';
    game.render(ctx);

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

boot().catch((err) => {
  console.error('Boot error:', err);
  const pill = document.getElementById('status-pill');
  if (pill) pill.textContent = 'Load error: ' + err.message;
});
