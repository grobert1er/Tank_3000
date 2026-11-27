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
  const btnMute = document.getElementById('btn-mute');
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const btnControls = document.getElementById('btn-controls');
  const statusPill = document.getElementById('status-pill');

  // Modals
  const controlsModal = document.getElementById('controls-modal');
  const lobbyModal = document.getElementById('lobby-modal');
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
    btnAddBot.hidden = !lobby.isHost || lobby.slots.length >= 5;
    btnStartOnline.hidden = !lobby.isHost;
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

        if (lobby.isHost && lobby.slots.length > 2) {
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'btn-mini danger';
          rm.textContent = '×';
          rm.title = 'Remove Bot';
          rm.addEventListener('click', () => net.hostConfig('remove_slot', { index: idx }));
          rightEl.appendChild(rm);
        }
      } else {
        const tag = document.createElement('span');
        tag.className = 'slot-status' + (s.connected === false ? ' reconnecting' : '');
        tag.textContent = s.connected === false ? 'Reconnecting...' : 'Online';
        rightEl.appendChild(tag);
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

  net = new NetworkClient({
    onConnectionChange: (ok) => {
      if (!ok && game && game.mode === 'online') {
        statusPill.textContent = 'Disconnected from room';
      }
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
      statusPill.textContent = 'Local Mode';
    },
    onMatchStart: (msg) => {
      lobbyModal.hidden = true;
      game.startOnlineMatch({
        seed: msg.seed,
        krajina: msg.krajina,
        players: msg.players,
        mySlot: msg.mySlot,
        isHost: msg.isHost,
      });
      statusPill.textContent = `Online Room ${msg.code} · Round 1`;
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

  game = new TankGame(renderer, sound, {
    onOnlineAim: (payload) => net.sendAim(payload),
    onOnlineAction: (payload) => net.sendAction(payload),
    onOnlineShopBuy: ({ slot, kind, index }) => net.sendShopBuy(slot, kind, index),
    onOnlineShopReady: () => net.sendShopReady(),
    onStatusChange: (st) => {
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
    if (!lobbyModal.hidden || !controlsModal.hidden) return;
    if (document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    game.handleKeyDown(ev);
  });

  window.addEventListener('keyup', (ev) => {
    game.handleKeyUp(ev);
  });

  window.addEventListener('blur', () => game.clearKeys());

  // ==================== OUTER BAR & MODAL WIRING ====================

  btnLocal.addEventListener('click', () => {
    net.leaveRoom();
    lobbyModal.hidden = true;
    game.resetToTitle();
  });

  btnOnline.addEventListener('click', () => {
    sound.unlock();
    showLobbyError('');
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
      controlsModal.hidden = true;
      lobbyModal.hidden = true;
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
    // In local mode, clamp dt so backgrounding pauses play cleanly.
    // In online mode, step all missed 25Hz ticks so peers stay in deterministic lockstep.
    const maxDt = isOnline ? 30000 : 120;
    const maxSteps = isOnline ? 750 : 5;
    acc += Math.min(maxDt, elapsed);
    let steps = 0;
    while (acc >= FRAME_MS && steps < maxSteps) {
      game.tick();
      acc -= FRAME_MS;
      steps++;
    }
    if (acc >= FRAME_MS * maxSteps) acc = 0;
  };

  // Background ticker keeps online simulation & host bots advancing while tab is hidden
  setInterval(() => {
    if (document.hidden && game.mode === 'online') {
      stepSimulation(performance.now());
    }
  }, 200);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      stepSimulation(performance.now());
      net.handleVisibilityResume();
    } else {
      game.clearKeys();
    }
  });

  function loop(now) {
    stepSimulation(now);

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
