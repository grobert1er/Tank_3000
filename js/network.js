// Dual-Transport Multiplayer Client:
//  - 'p2p': Serverless WebRTC Peer-to-Peer via PeerJS (works on GitHub Pages, Netlify, Cloudflare Pages, etc.)
//           Includes heartbeat keepalive, tab-switch resilience, and automatic session reconnection.
//  - 'ws' : Direct RFC 6455 WebSocket to server.py (for isolated LAN / self-hosted Python server)

import { PLAYER_COLORS, AI_DIFFICULTIES } from './constants.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PEER_PREFIX = 'tank3000-v1-';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const RECONNECT_GRACE_MS = 18000; // Host keeps disconnected peer's slot reserved for 18s (tab switch / mobile sleep)
const HEARTBEAT_MS = 5000;

function genRoomCode() {
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

function genSessionId() {
  return 's' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function randomSeed() {
  return Math.floor(Math.random() * 0x7ffffffe) + 1;
}

export class NetworkClient {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.transport = 'p2p'; // 'p2p' | 'ws'
    this.connected = false;
    this.roomCode = null;
    this.lobby = null;

    // WebSocket state
    this.ws = null;

    // PeerJS WebRTC state
    this._peer = null;
    this._hostConn = null;        // guest -> host DataConnection
    this._p2pRoom = null;         // host-side authoritative room state
    this._p2pRole = null;         // 'host' | 'guest' | null
    this._peerSeq = 0;
    this._closingP2P = false;
    this._sessionId = genSessionId();
    this._guestSession = null;    // { code, name, sessionId } for auto-reconnect
    this._reconnecting = false;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._heartbeatTimer = null;
    this._pendingGuestMsgs = [];  // buffer outbound messages briefly during reconnect
  }

  setTransport(mode) {
    this.transport = mode === 'ws' ? 'ws' : 'p2p';
  }

  // Called when browser tab becomes visible again after backgrounding
  handleVisibilityResume() {
    if (this.transport !== 'p2p' || this._closingP2P) return;

    // Ensure PeerJS signaling socket reconnects if throttled/dropped in background
    if (this._peer && this._peer.disconnected && !this._peer.destroyed) {
      try { this._peer.reconnect(); } catch {}
    }

    if (this._p2pRole === 'host' && this._p2pRoom) {
      // Send immediate heartbeat ping to all connected guests to wake DataChannels
      for (const conn of this._p2pRoom.conns.values()) {
        if (conn && conn.open) {
          try { conn.send({ type: 'ping', t: Date.now() }); } catch {}
        }
      }
    } else if (this._p2pRole === 'guest' && this._guestSession) {
      if (this._hostConn && this._hostConn.open) {
        try { this._hostConn.send({ type: 'ping', t: Date.now() }); } catch {}
      } else {
        // Tab backgrounding closed the DataChannel -> reconnect immediately
        this._attemptGuestReconnect(true);
      }
    }
  }

  // ==================== PUBLIC API ====================

  async createRoom(name) {
    const cleanName = String(name || 'Player 1').trim().slice(0, 14) || 'Player 1';
    if (this.transport === 'ws') {
      await this._connectWS();
      this._sendWS({ type: 'create_room', name: cleanName });
    } else {
      await this._createP2PRoom(cleanName);
    }
  }

  async joinRoom(code, name) {
    const cleanCode = String(code || '').trim().toUpperCase();
    const cleanName = String(name || 'Player').trim().slice(0, 14) || 'Player';
    if (!cleanCode) {
      throw new Error('Enter a 4-character room code.');
    }
    if (this.transport === 'ws') {
      await this._connectWS();
      this._sendWS({ type: 'join_room', code: cleanCode, name: cleanName });
    } else {
      await this._joinP2PRoom(cleanCode, cleanName);
    }
  }

  leaveRoom() {
    if (this.transport === 'ws' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendWS({ type: 'leave_room' });
    }
    if (this._peer || this._p2pRoom || this._hostConn || this._guestSession) {
      this._teardownP2P(true);
    }
    this.roomCode = null;
    this.lobby = null;
  }

  updateProfile(patch) {
    if (this._guestSession && patch?.name) {
      this._guestSession.name = String(patch.name).trim().slice(0, 14) || this._guestSession.name;
    }
    this._sendOut({ type: 'update_profile', ...patch });
  }

  hostConfig(action, extra = {}) {
    this._sendOut({ type: 'host_config', action, ...extra });
  }

  startMatch() {
    this._sendOut({ type: 'start_match' });
  }

  sendAim(payload) {
    this._sendOut({ type: 'aim', payload });
  }

  sendAction(payload) {
    this._sendOut({ type: 'action', payload });
  }

  sendShopBuy(slot, kind, index) {
    this._sendOut({ type: 'shop_buy', slot, kind, index });
  }

  sendShopReady() {
    this._sendOut({ type: 'shop_ready' });
  }

  // ==================== OUTBOUND ROUTER ====================

  _sendOut(obj) {
    if (this.transport === 'ws') {
      this._sendWS(obj);
      return;
    }
    if (this._p2pRole === 'host' && this._p2pRoom) {
      this._p2pHostHandle('host', null, obj);
    } else if (this._p2pRole === 'guest') {
      if (this._hostConn && this._hostConn.open) {
        try {
          this._hostConn.send(obj);
        } catch (err) {
          console.warn('P2P send error:', err);
        }
      } else if (this._guestSession && obj.type !== 'aim') {
        // Queue critical messages while momentarily reconnecting
        this._pendingGuestMsgs.push(obj);
        if (this._pendingGuestMsgs.length > 20) this._pendingGuestMsgs.shift();
        this._attemptGuestReconnect(false);
      }
    }
  }

  // ==================== WEBSOCKET TRANSPORT ====================

  _connectWS() {
    this._teardownP2P(false);
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/ws`;
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch {}
          reject(new Error('Timed out connecting to WebSocket server.'));
        }
      }, 6000);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        this.handlers.onConnectionChange?.(true);
        resolve();
      };
      ws.onerror = () => {
        this.connected = false;
        this.handlers.onConnectionChange?.(false);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Could not connect to LAN WebSocket server. Start server.py or switch to Online P2P mode.'));
        }
      };
      ws.onclose = () => {
        this.connected = false;
        this.roomCode = null;
        this.lobby = null;
        this.handlers.onConnectionChange?.(false);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          this._dispatch(msg);
        } catch (err) {
          console.warn('Bad WS message:', err);
        }
      };
    });
  }

  _sendWS(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _closeWS() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  // ==================== WEBRTC P2P (PEERJS) TRANSPORT ====================

  _ensurePeerJS() {
    if (typeof window.Peer !== 'function') {
      throw new Error('PeerJS WebRTC library failed to load. Check js/vendor/peerjs.min.js.');
    }
    return window.Peer;
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this._closingP2P) return;
      if (this._peer && this._peer.disconnected && !this._peer.destroyed) {
        try { this._peer.reconnect(); } catch {}
      }
      if (this._p2pRole === 'host' && this._p2pRoom) {
        for (const conn of this._p2pRoom.conns.values()) {
          if (conn && conn.open) {
            try { conn.send({ type: 'ping', t: Date.now() }); } catch {}
          }
        }
      } else if (this._p2pRole === 'guest' && this._hostConn && this._hostConn.open) {
        try { this._hostConn.send({ type: 'ping', t: Date.now() }); } catch {}
      }
    }, HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnecting = false;
    this._reconnectAttempt = 0;
  }

  _teardownP2P(notifyPeers = false) {
    this._closingP2P = true;
    this._stopHeartbeat();
    this._clearReconnectTimer();
    this._pendingGuestMsgs = [];
    this._guestSession = null;

    if (this._p2pRoom) {
      for (const timer of this._p2pRoom.graceTimers.values()) {
        clearTimeout(timer);
      }
      this._p2pRoom.graceTimers.clear();
    }

    if (notifyPeers && this._p2pRole === 'host' && this._p2pRoom) {
      for (const conn of this._p2pRoom.conns.values()) {
        try {
          if (conn.open) conn.send({ type: 'host_closed', message: 'Host closed the room.' });
          conn.close();
        } catch {}
      }
    }
    if (notifyPeers && this._p2pRole === 'guest' && this._hostConn) {
      try {
        if (this._hostConn.open) this._hostConn.send({ type: 'leave_room' });
        this._hostConn.close();
      } catch {}
    }
    if (this._peer) {
      try { this._peer.destroy(); } catch {}
    }
    this._peer = null;
    this._hostConn = null;
    this._p2pRoom = null;
    this._p2pRole = null;
    this.connected = false;
  }

  _openPeer(peerId) {
    const PeerCtor = this._ensurePeerJS();
    return new Promise((resolve, reject) => {
      let settled = false;
      const peer = new PeerCtor(peerId, {
        debug: 0,
        config: { iceServers: ICE_SERVERS },
      });

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { peer.destroy(); } catch {}
          reject(new Error('Could not reach WebRTC signaling server (0.peerjs.com). Check your internet connection.'));
        }
      }, 12000);

      peer.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(peer);
      });

      peer.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { peer.destroy(); } catch {}
          const e = new Error(err?.message || `P2P error (${err?.type || 'unknown'})`);
          e.peerType = err?.type;
          reject(e);
        }
      });
    });
  }

  async _createP2PRoom(hostName) {
    this._closeWS();
    this._teardownP2P(false);
    this._closingP2P = false;

    let peer = null;
    let code = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      code = genRoomCode();
      try {
        peer = await this._openPeer(PEER_PREFIX + code);
        break;
      } catch (err) {
        if (err.peerType === 'unavailable-id' && attempt < 4) {
          continue;
        }
        throw err;
      }
    }

    this._peer = peer;
    this._p2pRole = 'host';
    this.connected = true;
    this.roomCode = code;

    this._p2pRoom = {
      code,
      hostId: 'host',
      krajina: 0,
      inMatch: false,
      roundNum: 0,
      readyIds: new Set(),
      slots: [
        { kind: 'human', clientId: 'host', sessionId: 'host', name: hostName, col: PLAYER_COLORS[0], dif: 'normal' },
        { kind: 'ai', clientId: null, sessionId: null, name: 'Bot 2', col: PLAYER_COLORS[1], dif: 'normal' },
      ],
      conns: new Map(),       // cid -> DataConnection
      graceTimers: new Map(), // cid -> timeout handle for temporary disconnects
    };

    // Keep signaling alive so new players & reconnecting guests can reach host
    peer.on('disconnected', () => {
      if (!this._closingP2P && this._peer === peer && !peer.destroyed) {
        setTimeout(() => {
          if (!this._closingP2P && this._peer === peer && peer.disconnected && !peer.destroyed) {
            try { peer.reconnect(); } catch {}
          }
        }, 500);
      }
    });

    peer.on('error', (err) => {
      // Non-fatal signaling errors after room open should not destroy active WebRTC DataChannels
      console.warn('Host PeerJS notice:', err?.type, err?.message);
    });

    peer.on('connection', (conn) => {
      // Track the logical cid bound to this DataConnection (may rebind on rejoin_room)
      const state = { cid: `p${++this._peerSeq}` };
      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ping') {
          try { if (conn.open) conn.send({ type: 'pong', t: msg.t }); } catch {}
          return;
        }
        if (msg.type === 'pong') return;
        this._p2pHostHandle(state, conn, msg);
      });
      conn.on('close', () => {
        // Only trigger grace disconnect if this conn is still the active conn for state.cid
        if (this._p2pRoom && this._p2pRoom.conns.get(state.cid) === conn) {
          this._p2pHostOnPeerDisconnect(state.cid, false);
        }
      });
      conn.on('error', (err) => {
        console.warn('Host conn error:', state.cid, err);
        if (!conn.open && this._p2pRoom && this._p2pRoom.conns.get(state.cid) === conn) {
          this._p2pHostOnPeerDisconnect(state.cid, false);
        }
      });
    });

    this._startHeartbeat();
    this.handlers.onConnectionChange?.(true);
    this._p2pBroadcastLobby();
  }

  async _joinP2PRoom(code, guestName) {
    this._closeWS();
    this._teardownP2P(false);
    this._closingP2P = false;
    this._sessionId = genSessionId();

    const peer = await this._openPeer(undefined);
    this._peer = peer;
    this._p2pRole = 'guest';
    this._guestSession = { code, name: guestName, sessionId: this._sessionId };

    peer.on('disconnected', () => {
      if (!this._closingP2P && this._peer === peer && !peer.destroyed) {
        setTimeout(() => {
          if (!this._closingP2P && this._peer === peer && peer.disconnected && !peer.destroyed) {
            try { peer.reconnect(); } catch {}
          }
        }, 500);
      }
    });

    await this._dialHost(code, { type: 'join_room', code, name: guestName, sessionId: this._sessionId }, true);
    this._startHeartbeat();
  }

  async _dialHost(code, helloMsg, isInitialJoin) {
    const peer = this._peer;
    if (!peer || peer.destroyed) {
      throw new Error('Peer connection closed.');
    }
    const targetId = PEER_PREFIX + code;
    const conn = peer.connect(targetId, { reliable: true, serialization: 'json' });
    this._hostConn = conn;

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { conn.close(); } catch {}
          if (isInitialJoin) this._teardownP2P(false);
          reject(new Error(`Timed out joining room '${code}'. Make sure the host's lobby is open.`));
        }
      }, isInitialJoin ? 12000 : 7000);

      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { conn.close(); } catch {}
        if (isInitialJoin) this._teardownP2P(false);
        reject(new Error(message));
      };

      const onPeerErr = (err) => {
        if (settled) return;
        if (err?.type === 'peer-unavailable') {
          fail(`Room '${code}' not found. Check the code or make sure the host has created it.`);
        } else {
          fail(err?.message || `Could not join room '${code}'.`);
        }
      };
      peer.once('error', onPeerErr);

      conn.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.off?.('error', onPeerErr);
        this.connected = true;
        this.roomCode = code;
        this._clearReconnectTimer();
        this.handlers.onConnectionChange?.(true);
        conn.send(helloMsg);

        // Flush any queued messages from momentary reconnect
        if (this._pendingGuestMsgs.length) {
          const queued = this._pendingGuestMsgs.splice(0);
          for (const m of queued) {
            try { conn.send(m); } catch {}
          }
        }
        resolve();
      });

      conn.on('error', () => {
        fail(`Connection to room '${code}' failed.`);
      });
    });

    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ping') {
        try { if (conn.open) conn.send({ type: 'pong', t: msg.t }); } catch {}
        return;
      }
      if (msg.type === 'pong') return;
      if (msg.type === 'host_closed') {
        // Explicit host close -> do NOT try to reconnect
        const errMsg = msg.message || 'Host closed the room.';
        this._teardownP2P(false);
        this.roomCode = null;
        this.lobby = null;
        this.handlers.onLeftRoom?.();
        this.handlers.onError?.(errMsg);
        return;
      }
      this._dispatch(msg);
    });

    conn.on('close', () => {
      if (this._closingP2P || this._hostConn !== conn) return;
      this.connected = false;
      this._hostConn = null;
      // Attempt automatic silent reconnection (handles browser tab throttling / sleep)
      this._attemptGuestReconnect(false);
    });
  }

  _attemptGuestReconnect(immediate = false) {
    if (this._closingP2P || !this._guestSession || this._p2pRole !== 'guest') return;
    if (this._hostConn && this._hostConn.open) return;
    if (this._reconnecting && !immediate) return;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    const maxAttempts = 6;
    if (this._reconnectAttempt >= maxAttempts) {
      const wasInMatch = Boolean(this.lobby?.inMatch);
      this._teardownP2P(false);
      this.roomCode = null;
      this.lobby = null;
      this.handlers.onConnectionChange?.(false);
      if (!wasInMatch) {
        this.handlers.onLeftRoom?.();
        this.handlers.onError?.('Connection to host was lost.');
      }
      return;
    }

    this._reconnecting = true;
    this.handlers.onReconnecting?.(true);
    const delay = immediate ? 150 : (this._reconnectAttempt === 0 ? 600 : 2000);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._closingP2P || !this._guestSession) return;
      this._reconnectAttempt++;
      try {
        if (!this._peer || this._peer.destroyed) {
          this._peer = await this._openPeer(undefined);
        } else if (this._peer.disconnected) {
          try { this._peer.reconnect(); } catch {}
          await new Promise((r) => setTimeout(r, 400));
        }
        const sess = this._guestSession;
        await this._dialHost(
          sess.code,
          { type: 'rejoin_room', code: sess.code, name: sess.name, sessionId: sess.sessionId },
          false
        );
        this.handlers.onReconnecting?.(false);
      } catch {
        this._reconnecting = false;
        this._attemptGuestReconnect(false);
      }
    }, delay);
  }

  // ==================== HOST-SIDE P2P ROOM LOGIC ====================

  _p2pSlotOf(cid) {
    const room = this._p2pRoom;
    if (!room) return 0;
    for (let i = 0; i < room.slots.length; i++) {
      if (room.slots[i].kind === 'human' && room.slots[i].clientId === cid) {
        return i + 1;
      }
    }
    return 0;
  }

  _p2pHumanIds() {
    const room = this._p2pRoom;
    if (!room) return [];
    return room.slots
      .filter((s) => s.kind === 'human' && (s.clientId === 'host' || room.conns.has(s.clientId)))
      .map((s) => s.clientId);
  }

  _p2pSerializeLobby(viewerId) {
    const room = this._p2pRoom;
    return {
      type: 'lobby_state',
      code: room.code,
      krajina: room.krajina,
      inMatch: room.inMatch,
      isHost: viewerId === room.hostId,
      mySlot: this._p2pSlotOf(viewerId),
      slots: room.slots.map((s, idx) => ({
        slot: idx + 1,
        kind: s.kind,
        name: s.name,
        col: s.col,
        dif: s.dif,
        isMe: s.clientId === viewerId,
        isHost: s.clientId === room.hostId,
        connected: s.kind === 'ai' || s.clientId === 'host' || room.conns.has(s.clientId),
      })),
    };
  }

  _p2pSendTo(cid, msg) {
    const room = this._p2pRoom;
    if (!room) return;
    if (cid === 'host') {
      this._dispatch(msg);
      return;
    }
    const conn = room.conns.get(cid);
    if (conn && conn.open) {
      try {
        conn.send(msg);
      } catch (err) {
        console.warn('P2P sendTo error:', cid, err);
      }
    }
  }

  _p2pBroadcast(msg, excludeId = null) {
    const room = this._p2pRoom;
    if (!room) return;
    if (excludeId !== 'host') {
      this._dispatch(msg);
    }
    for (const [cid, conn] of room.conns.entries()) {
      if (cid === excludeId) continue;
      if (conn && conn.open) {
        try {
          conn.send(msg);
        } catch {}
      }
    }
  }

  _p2pBroadcastLobby() {
    const room = this._p2pRoom;
    if (!room) return;
    this._p2pSendTo('host', this._p2pSerializeLobby('host'));
    for (const cid of room.conns.keys()) {
      this._p2pSendTo(cid, this._p2pSerializeLobby(cid));
    }
  }

  _p2pHostHandle(stateOrCid, conn, msg) {
    const room = this._p2pRoom;
    if (!room) return;
    const isStateObj = typeof stateOrCid === 'object' && stateOrCid !== null;
    let cid = isStateObj ? stateOrCid.cid : stateOrCid;
    const mtype = msg.type;

    // Seamless reconnection of a peer returning from a backgrounded tab
    if (mtype === 'rejoin_room' && cid !== 'host') {
      const sessId = String(msg.sessionId || '');
      const existing = sessId ? room.slots.find((s) => s.kind === 'human' && s.sessionId === sessId) : null;
      if (existing) {
        const oldCid = existing.clientId;
        if (room.graceTimers.has(oldCid)) {
          clearTimeout(room.graceTimers.get(oldCid));
          room.graceTimers.delete(oldCid);
        }
        // Rebind this new DataConnection to the preserved clientId
        if (isStateObj) stateOrCid.cid = oldCid;
        cid = oldCid;
        room.conns.set(oldCid, conn);
        if (!room.inMatch) {
          this._p2pBroadcastLobby();
        } else {
          this._p2pSendTo(oldCid, {
            type: 'rejoined_match',
            code: room.code,
            mySlot: this._p2pSlotOf(oldCid),
            isHost: false,
          });
        }
        return;
      }
      // If session wasn't found and lobby is still open, fall through as a fresh join
      if (!room.inMatch) {
        this._p2pHostHandle(stateOrCid, conn, { ...msg, type: 'join_room' });
      } else {
        try { conn?.send({ type: 'error', message: `Room '${room.code}' is already in a match.` }); } catch {}
      }
      return;
    }

    if (mtype === 'join_room' && cid !== 'host') {
      if (room.inMatch) {
        try { conn?.send({ type: 'error', message: `Room '${room.code}' is already in a match.` }); } catch {}
        return;
      }
      const cleanName = String(msg.name || `Player ${room.slots.length + 1}`).trim().slice(0, 14) || 'Player';
      const sessId = String(msg.sessionId || cid);
      let placed = false;
      if (room.slots.length < 5) {
        const used = new Set(room.slots.map((s) => s.col));
        const pickCol = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[room.slots.length % PLAYER_COLORS.length];
        room.slots.push({ kind: 'human', clientId: cid, sessionId: sessId, name: cleanName, col: pickCol, dif: 'normal' });
        placed = true;
      } else {
        for (const s of room.slots) {
          if (s.kind === 'ai') {
            s.kind = 'human';
            s.clientId = cid;
            s.sessionId = sessId;
            s.name = cleanName;
            placed = true;
            break;
          }
        }
      }
      if (!placed) {
        try { conn?.send({ type: 'error', message: `Room '${room.code}' is full (max 5 players).` }); } catch {}
        return;
      }
      room.conns.set(cid, conn);
      this._p2pBroadcastLobby();
      return;
    }

    if (mtype === 'leave_room' && cid !== 'host') {
      this._p2pHostOnPeerDisconnect(cid, true);
      return;
    }

    if (mtype === 'update_profile') {
      const slotIdx = this._p2pSlotOf(cid) - 1;
      if (slotIdx >= 0 && slotIdx < room.slots.length) {
        if ('name' in msg) {
          const nm = String(msg.name || '').trim().slice(0, 14);
          if (nm) room.slots[slotIdx].name = nm;
        }
        if ('col' in msg && PLAYER_COLORS.includes(Number(msg.col))) {
          room.slots[slotIdx].col = Number(msg.col);
        }
        this._p2pBroadcastLobby();
      }
      return;
    }

    if (mtype === 'host_config' && cid === 'host' && !room.inMatch) {
      const action = msg.action;
      if (action === 'set_krajina') {
        const k = Number(msg.krajina ?? 0);
        if ([0, 1, 2, 3].includes(k)) room.krajina = k;
      } else if (action === 'add_bot' && room.slots.length < 5) {
        const used = new Set(room.slots.map((s) => s.col));
        const pickCol = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[room.slots.length % PLAYER_COLORS.length];
        room.slots.push({
          kind: 'ai',
          clientId: null,
          sessionId: null,
          name: `Bot ${room.slots.length + 1}`,
          col: pickCol,
          dif: 'normal',
        });
      } else if (action === 'remove_slot') {
        const idx = Number(msg.index ?? -1);
        if (idx >= 0 && idx < room.slots.length && room.slots.length > 2 && room.slots[idx].kind === 'ai') {
          room.slots.splice(idx, 1);
        }
      } else if (action === 'set_bot_dif') {
        const idx = Number(msg.index ?? -1);
        const dif = String(msg.dif || 'normal');
        if (idx >= 0 && idx < room.slots.length && room.slots[idx].kind === 'ai' && AI_DIFFICULTIES.includes(dif)) {
          room.slots[idx].dif = dif;
        }
      } else if (action === 'set_bot_name') {
        const idx = Number(msg.index ?? -1);
        const nm = String(msg.name || '').trim().slice(0, 14);
        if (idx >= 0 && idx < room.slots.length && room.slots[idx].kind === 'ai' && nm) {
          room.slots[idx].name = nm;
        }
      } else if (action === 'set_slot_col') {
        const idx = Number(msg.index ?? -1);
        const col = Number(msg.col);
        if (idx >= 0 && idx < room.slots.length && PLAYER_COLORS.includes(col)) {
          room.slots[idx].col = col;
        }
      }
      this._p2pBroadcastLobby();
      return;
    }

    if (mtype === 'start_match' && cid === 'host' && !room.inMatch) {
      if (room.slots.length < 2) {
        this._p2pSendTo('host', { type: 'error', message: 'Need at least 2 players to start.' });
        return;
      }
      room.inMatch = true;
      room.roundNum = 1;
      room.readyIds.clear();
      const seed = randomSeed();
      const players = room.slots.map((s) => ({
        name: s.name,
        col: s.col,
        type: s.kind === 'human' ? 'tank' : 'ai',
        dif: s.dif,
      }));
      const allIds = ['host', ...room.conns.keys()];
      for (const viewerId of allIds) {
        this._p2pSendTo(viewerId, {
          type: 'match_start',
          code: room.code,
          seed,
          krajina: room.krajina,
          players,
          mySlot: this._p2pSlotOf(viewerId),
          isHost: viewerId === 'host',
        });
      }
      return;
    }

    if ((mtype === 'aim' || mtype === 'action') && room.inMatch) {
      this._p2pBroadcast(msg, cid);
      return;
    }

    if (mtype === 'shop_buy' && room.inMatch) {
      this._p2pBroadcast(
        {
          type: 'action',
          payload: {
            type: 'shop_buy',
            slot: msg.slot,
            kind: msg.kind,
            index: msg.index,
          },
        },
        cid
      );
      return;
    }

    if (mtype === 'shop_ready' && room.inMatch) {
      room.readyIds.add(cid);
      const humans = this._p2pHumanIds();
      const readyCnt = humans.filter((hid) => room.readyIds.has(hid)).length;
      this._p2pBroadcast({
        type: 'shop_status',
        ready: readyCnt,
        total: humans.length,
      });
      if (humans.length > 0 && readyCnt >= humans.length) {
        room.readyIds.clear();
        room.roundNum += 1;
        this._p2pBroadcast({
          type: 'next_round',
          round: room.roundNum,
          seed: randomSeed(),
        });
      }
    }
  }

  _p2pHostOnPeerDisconnect(cid, immediate = false) {
    const room = this._p2pRoom;
    if (!room) return;
    const hadConn = room.conns.delete(cid);
    const hasSlot = room.slots.some((s) => s.kind === 'human' && s.clientId === cid);
    if (!hadConn && !hasSlot) return;

    if (immediate) {
      if (room.graceTimers.has(cid)) {
        clearTimeout(room.graceTimers.get(cid));
        room.graceTimers.delete(cid);
      }
      this._p2pHostFinalizeRemove(cid);
      return;
    }

    // Reserve slot during grace period so a guest returning from another tab seamlessly rejoins
    if (!room.inMatch) {
      this._p2pBroadcastLobby(); // shows "Reconnecting..." badge
    }
    if (!room.graceTimers.has(cid)) {
      const timer = setTimeout(() => {
        room.graceTimers.delete(cid);
        if (!room.conns.has(cid)) {
          this._p2pHostFinalizeRemove(cid);
        }
      }, RECONNECT_GRACE_MS);
      room.graceTimers.set(cid, timer);
    }
  }

  _p2pHostFinalizeRemove(cid) {
    const room = this._p2pRoom;
    if (!room) return;
    room.readyIds.delete(cid);

    if (!room.inMatch) {
      room.slots = room.slots.filter((s) => s.clientId !== cid);
      while (room.slots.length < 2) {
        room.slots.push({
          kind: 'ai',
          clientId: null,
          sessionId: null,
          name: `Bot ${room.slots.length + 1}`,
          col: PLAYER_COLORS[room.slots.length % PLAYER_COLORS.length],
          dif: 'normal',
        });
      }
      this._p2pBroadcastLobby();
    } else {
      let slotNum = 0;
      for (let i = 0; i < room.slots.length; i++) {
        if (room.slots[i].clientId === cid) {
          room.slots[i].kind = 'ai';
          room.slots[i].clientId = null;
          room.slots[i].sessionId = null;
          slotNum = i + 1;
          break;
        }
      }
      if (slotNum > 0) {
        const allIds = ['host', ...room.conns.keys()];
        for (const viewerId of allIds) {
          this._p2pSendTo(viewerId, {
            type: 'peer_left',
            slot: slotNum,
            isHost: viewerId === 'host',
          });
        }
      }
      const humans = this._p2pHumanIds();
      if (humans.length > 0 && humans.every((hid) => room.readyIds.has(hid))) {
        room.readyIds.clear();
        room.roundNum += 1;
        this._p2pBroadcast({
          type: 'next_round',
          round: room.roundNum,
          seed: randomSeed(),
        });
      }
    }
  }

  // ==================== INBOUND DISPATCH ====================

  _dispatch(msg) {
    switch (msg.type) {
      case 'lobby_state':
        this.roomCode = msg.code;
        this.lobby = msg;
        this.handlers.onLobbyState?.(msg);
        break;
      case 'left_room':
        this.roomCode = null;
        this.lobby = null;
        this.handlers.onLeftRoom?.();
        break;
      case 'match_start':
        if (this.lobby) this.lobby.inMatch = true;
        this.handlers.onMatchStart?.(msg);
        break;
      case 'rejoined_match':
        this.handlers.onReconnecting?.(false);
        break;
      case 'aim':
        this.handlers.onRemoteAim?.(msg.payload);
        break;
      case 'action':
        this.handlers.onRemoteAction?.(msg.payload);
        break;
      case 'shop_status':
        this.handlers.onShopStatus?.(msg);
        break;
      case 'next_round':
        this.handlers.onNextRound?.(msg);
        break;
      case 'peer_left':
        this.handlers.onPeerLeft?.(msg);
        break;
      case 'error':
        this.handlers.onError?.(msg.message);
        break;
    }
  }
}
