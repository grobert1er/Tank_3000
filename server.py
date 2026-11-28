#!/usr/bin/env python3
"""
Tank 3000 - Zero-dependency Python 3 HTTP + RFC 6455 WebSocket Multiplayer Server.
Serves static game files and coordinates 2-5 player Online/LAN rooms on one port.

Usage:
    python server.py [--host 0.0.0.0] [--port 8000]
"""

import argparse
import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import random
import socket
import struct
import urllib.parse
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

DEFAULT_COLORS = [0xF02400, 0x00CC33, 0x0033FF, 0x333333, 0xF0DF0F, 0xEA9500]
CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("audio/mpeg", ".mp3")


class Client:
    def __init__(self, cid: str, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.id = cid
        self.reader = reader
        self.writer = writer
        self.room_code: str | None = None
        self.name = "Player"
        self.closed = False

    async def send_json(self, obj: dict):
        if self.closed:
            return
        payload = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        await self.send_ws_frame(0x1, payload)

    async def send_ws_frame(self, opcode: int, payload: bytes):
        if self.closed:
            return
        header = bytearray([0x80 | (opcode & 0x0F)])
        n = len(payload)
        if n < 126:
            header.append(n)
        elif n < 65536:
            header.append(126)
            header.extend(struct.pack("!H", n))
        else:
            header.append(127)
            header.extend(struct.pack("!Q", n))
        try:
            self.writer.write(bytes(header) + payload)
            await self.writer.drain()
        except Exception:
            self.closed = True


class Room:
    def __init__(self, code: str, host: Client):
        self.code = code
        self.host_id = host.id
        self.krajina = 0  # 0=Random, 1=Mountains, 2=Forest, 3=Desert
        self.preset = "balanced"  # "balanced" | "classic"
        self.turn_timer = 0       # 0 | 20 | 30
        self.loaded_save: dict | None = None
        self.in_match = False
        self.round_num = 0
        self.ready_clients: set[str] = set()
        # 2..5 slots: each slot is {'kind': 'human'|'ai', 'client_id': str|None, 'name': str, 'col': int, 'dif': str}
        self.slots: list[dict] = [
            {"kind": "human", "client_id": host.id, "name": host.name, "col": DEFAULT_COLORS[0], "dif": "normal"},
            {"kind": "ai", "client_id": None, "name": "Bot 2", "col": DEFAULT_COLORS[1], "dif": "normal"},
        ]
        self.clients: dict[str, Client] = {host.id: host}

    def human_client_ids(self) -> list[str]:
        return [s["client_id"] for s in self.slots if s["kind"] == "human" and s["client_id"] in self.clients]

    def slot_of(self, client_id: str) -> int:
        for idx, s in enumerate(self.slots):
            if s["kind"] == "human" and s["client_id"] == client_id:
                return idx + 1
        return 0

    def serialize_lobby(self, viewer_id: str) -> dict:
        saved = self.loaded_save
        return {
            "type": "lobby_state",
            "code": self.code,
            "krajina": self.krajina,
            "preset": self.preset,
            "turnTimer": self.turn_timer,
            "loadedSaveInfo": (
                {
                    "label": saved.get("label") or f"Round {saved.get('gameRound', 1)}",
                    "round": saved.get("gameRound", 1),
                    "scene": saved.get("scene", "battle"),
                    "players": [
                        {"name": p.get("name", "Player"), "score": p.get("total_score", 0)}
                        for p in (saved.get("playerData") or [])
                    ],
                }
                if saved
                else None
            ),
            "inMatch": self.in_match,
            "isHost": viewer_id == self.host_id,
            "mySlot": self.slot_of(viewer_id),
            "slots": [
                {
                    "slot": idx + 1,
                    "kind": s["kind"],
                    "name": s["name"],
                    "col": s["col"],
                    "dif": s["dif"],
                    "isMe": s["client_id"] == viewer_id,
                    "isHost": s["client_id"] == self.host_id,
                    "connected": s["kind"] == "ai" or s["client_id"] in self.clients,
                }
                for idx, s in enumerate(self.slots)
            ],
        }


class TankServer:
    def __init__(self, host: str = "0.0.0.0", port: int = 8000):
        self.host = host
        self.port = port
        self.rooms: dict[str, Room] = {}
        self._next_cid = 1

    def _gen_code(self) -> str:
        for _ in range(200):
            code = "".join(random.choice(CODE_CHARS) for _ in range(4))
            if code not in self.rooms:
                return code
        return f"R{random.randint(100, 999)}"

    async def broadcast_lobby(self, room: Room):
        await asyncio.gather(
            *(c.send_json(room.serialize_lobby(cid)) for cid, c in list(room.clients.items())),
            return_exceptions=True,
        )

    async def broadcast(self, room: Room, msg: dict, exclude_id: str | None = None):
        await asyncio.gather(
            *(c.send_json(msg) for cid, c in list(room.clients.items()) if cid != exclude_id),
            return_exceptions=True,
        )

    async def handle_ws_message(self, client: Client, msg: dict):
        mtype = msg.get("type")

        if mtype == "create_room":
            await self.leave_room(client)
            client.name = str(msg.get("name") or "Player 1").strip()[:14] or "Player 1"
            code = self._gen_code()
            room = Room(code, client)
            self.rooms[code] = room
            client.room_code = code
            await self.broadcast_lobby(room)
            return

        if mtype == "join_room":
            await self.leave_room(client)
            code = str(msg.get("code") or "").strip().upper()
            room = self.rooms.get(code)
            if not room:
                await client.send_json({"type": "error", "message": f"Room '{code}' not found."})
                return
            client.name = str(msg.get("name") or f"Player {len(room.slots)+1}").strip()[:14] or "Player"
            sess_id = str(msg.get("sessionId") or "")
            if room.in_match:
                # Allow disconnected / former-human players to rejoin mid-match!
                rejoin_idx = -1
                reclaimed = False
                lower_name = client.name.lower()
                if sess_id:
                    rejoin_idx = next((i for i, s in enumerate(room.slots) if s["kind"] == "ai" and s.get("original_session_id") == sess_id), -1)
                    if rejoin_idx >= 0:
                        reclaimed = True
                if rejoin_idx < 0:
                    rejoin_idx = next((i for i, s in enumerate(room.slots) if s["kind"] == "ai" and s.get("was_human") and (s.get("original_name") or s["name"]).lower() == lower_name), -1)
                    if rejoin_idx >= 0:
                        reclaimed = True
                if rejoin_idx < 0:
                    former = [i for i, s in enumerate(room.slots) if s["kind"] == "ai" and s.get("was_human")]
                    if len(former) == 1:
                        rejoin_idx = former[0]
                        reclaimed = True
                if rejoin_idx < 0:
                    await client.send_json({"type": "error", "message": f"Room '{code}' is already in a match (no disconnected player slot to rejoin)."})
                    return

                slot = room.slots[rejoin_idx]
                slot["kind"] = "human"
                slot["client_id"] = client.id
                slot["session_id"] = sess_id or client.id
                slot["was_human"] = True
                slot["original_session_id"] = slot["session_id"]
                slot["original_name"] = slot.get("original_name") or slot["name"]
                room.clients[client.id] = client
                client.room_code = code
                slot_num = rejoin_idx + 1

                if reclaimed:
                    await self.broadcast(room, {"type": "peer_reclaimed", "slot": slot_num, "name": slot["name"]})
                await client.send_json({
                    "type": "rejoined_match",
                    "code": room.code,
                    "mySlot": slot_num,
                    "isHost": client.id == room.host_id,
                    "reclaimed": reclaimed,
                })
                host_client = room.clients.get(room.host_id)
                if host_client and host_client.id != client.id:
                    await host_client.send_json({"type": "sync_requested", "targetCid": client.id, "slot": slot_num})
                return

            placed = False
            if room.loaded_save:
                for s in room.slots:
                    if s["kind"] == "ai" and s.get("want_human"):
                        s["kind"] = "human"
                        s["client_id"] = client.id
                        s["session_id"] = sess_id or client.id
                        s["was_human"] = True
                        s["original_session_id"] = s["session_id"]
                        s["original_name"] = client.name
                        s["name"] = client.name
                        s["want_human"] = False
                        placed = True
                        break
            if not placed and not room.loaded_save and len(room.slots) < 5:
                used_cols = {s["col"] for s in room.slots}
                pick_col = next((c for c in DEFAULT_COLORS if c not in used_cols), DEFAULT_COLORS[len(room.slots) % 6])
                room.slots.append({
                    "kind": "human",
                    "client_id": client.id,
                    "session_id": sess_id or client.id,
                    "was_human": True,
                    "original_session_id": sess_id or client.id,
                    "original_name": client.name,
                    "name": client.name,
                    "col": pick_col,
                    "dif": "normal",
                })
                placed = True
            elif not placed:
                for s in room.slots:
                    if s["kind"] == "ai":
                        s["kind"] = "human"
                        s["client_id"] = client.id
                        s["session_id"] = sess_id or client.id
                        s["was_human"] = True
                        s["original_session_id"] = s["session_id"]
                        s["original_name"] = client.name
                        s["name"] = client.name
                        placed = True
                        break
            if not placed:
                await client.send_json({"type": "error", "message": f"Room '{code}' is full (max 5 players)."})
                return

            room.clients[client.id] = client
            client.room_code = code
            await self.broadcast_lobby(room)
            return

        if mtype == "leave_room":
            await self.leave_room(client)
            await client.send_json({"type": "left_room"})
            return

        # All remaining messages require being inside a room
        room = self.rooms.get(client.room_code) if client.room_code else None
        if not room:
            return

        if mtype == "update_profile":
            slot_idx = room.slot_of(client.id) - 1
            if 0 <= slot_idx < len(room.slots):
                if "name" in msg:
                    nm = str(msg["name"]).strip()[:14]
                    if nm:
                        room.slots[slot_idx]["name"] = nm
                        room.slots[slot_idx]["original_name"] = nm
                        client.name = nm
                if "col" in msg and int(msg["col"]) in DEFAULT_COLORS:
                    want_col = int(msg["col"])
                    if all(i == slot_idx or s["col"] != want_col for i, s in enumerate(room.slots)):
                        room.slots[slot_idx]["col"] = want_col
                await self.broadcast_lobby(room)
            return

        if mtype == "host_config" and client.id == room.host_id and not room.in_match:
            action = msg.get("action")
            if action == "set_krajina":
                k = int(msg.get("krajina", 0))
                if k in (0, 1, 2, 3):
                    room.krajina = k
            elif action == "set_preset":
                room.preset = "classic" if msg.get("preset") == "classic" else "balanced"
            elif action == "set_turn_timer":
                sec = int(msg.get("turnTimer", 0))
                if sec in (0, 20, 30):
                    room.turn_timer = sec
            elif action == "set_loaded_save":
                save = msg.get("save")
                if isinstance(save, dict) and isinstance(save.get("playerData"), list) and 2 <= len(save["playerData"]) <= 5:
                    connected_humans = [s for s in room.slots if s["kind"] == "human"]
                    used_cols: set[int] = set()
                    new_slots = []
                    for i, pd in enumerate(save["playerData"]):
                        col = pd.get("col", DEFAULT_COLORS[i % len(DEFAULT_COLORS)])
                        if col not in DEFAULT_COLORS or col in used_cols:
                            col = next((c for c in DEFAULT_COLORS if c not in used_cols), DEFAULT_COLORS[i % len(DEFAULT_COLORS)])
                        used_cols.add(col)
                        new_slots.append({
                            "kind": "ai",
                            "client_id": None,
                            "name": pd.get("name") or "Player",
                            "col": col,
                            "dif": pd.get("dif", "normal"),
                            "want_human": pd.get("type") == "tank",
                        })
                    placed_indices: set[int] = set()
                    for h in connected_humans:
                        t_idx = next((i for i, s in enumerate(new_slots) if i not in placed_indices and s["want_human"]), -1)
                        if t_idx < 0:
                            t_idx = next((i for i in range(len(new_slots)) if i not in placed_indices), -1)
                        if t_idx >= 0:
                            placed_indices.add(t_idx)
                            new_slots[t_idx]["kind"] = "human"
                            new_slots[t_idx]["client_id"] = h["client_id"]
                            new_slots[t_idx]["want_human"] = False
                    room.slots = new_slots
                    room.loaded_save = save
                    room.krajina = int(save.get("krajinaSetting", 0))
                    room.preset = "classic" if save.get("balancePreset") == "classic" else "balanced"
                    tt = int(save.get("turnTimerSec", 0))
                    room.turn_timer = tt if tt in (0, 20, 30) else 0
            elif action == "clear_loaded_save":
                room.loaded_save = None
                for s in room.slots:
                    s.pop("want_human", None)
            elif action == "add_bot" and not room.loaded_save and len(room.slots) < 5:
                used_cols = {s["col"] for s in room.slots}
                pick_col = next((c for c in DEFAULT_COLORS if c not in used_cols), DEFAULT_COLORS[len(room.slots) % 6])
                room.slots.append({
                    "kind": "ai",
                    "client_id": None,
                    "name": f"Bot {len(room.slots) + 1}",
                    "col": pick_col,
                    "dif": "normal",
                })
            elif action == "remove_slot" and not room.loaded_save:
                idx = int(msg.get("index", -1))
                if 0 <= idx < len(room.slots) and len(room.slots) > 2 and room.slots[idx]["kind"] == "ai":
                    room.slots.pop(idx)
            elif action == "set_bot_dif":
                idx = int(msg.get("index", -1))
                dif = str(msg.get("dif", "normal"))
                if 0 <= idx < len(room.slots) and room.slots[idx]["kind"] == "ai" and dif in ("Very_easy", "easy", "normal", "hard", "very_hard"):
                    room.slots[idx]["dif"] = dif
            elif action == "set_bot_name":
                idx = int(msg.get("index", -1))
                nm = str(msg.get("name") or "").strip()[:14]
                if 0 <= idx < len(room.slots) and room.slots[idx]["kind"] == "ai" and nm:
                    room.slots[idx]["name"] = nm
            elif action == "set_slot_col":
                idx = int(msg.get("index", -1))
                col = int(msg.get("col", DEFAULT_COLORS[0]))
                if (
                    0 <= idx < len(room.slots)
                    and col in DEFAULT_COLORS
                    and all(i == idx or s["col"] != col for i, s in enumerate(room.slots))
                ):
                    room.slots[idx]["col"] = col
            await self.broadcast_lobby(room)
            return

        if mtype == "start_match" and client.id == room.host_id and not room.in_match:
            if len(room.slots) < 2:
                await client.send_json({"type": "error", "message": "Need at least 2 players to start."})
                return
            room.in_match = True
            saved_state = room.loaded_save
            room.round_num = max(1, int(saved_state.get("gameRound", 1))) if saved_state else 1
            room.loaded_save = None
            room.ready_clients.clear()
            seed = random.randint(1, 0x7FFFFFFF)
            players = [
                {
                    "name": s["name"],
                    "col": s["col"],
                    "type": "tank" if s["kind"] == "human" else "ai",
                    "dif": s["dif"],
                }
                for s in room.slots
            ]
            for cid, c in list(room.clients.items()):
                await c.send_json({
                    "type": "match_start",
                    "code": room.code,
                    "seed": seed,
                    "krajina": room.krajina,
                    "preset": room.preset,
                    "turnTimer": room.turn_timer,
                    "savedState": saved_state,
                    "players": players,
                    "mySlot": room.slot_of(cid),
                    "isHost": cid == room.host_id,
                })
            return

        if mtype == "aim" and room.in_match:
            await self.broadcast(room, msg, exclude_id=client.id)
            return

        if mtype == "action" and room.in_match:
            target_cid = msg.get("targetCid")
            if target_cid and target_cid in room.clients:
                await room.clients[target_cid].send_json({"type": "action", "payload": msg.get("payload")})
            else:
                await self.broadcast(room, {"type": "action", "payload": msg.get("payload")}, exclude_id=client.id)
            return

        if mtype == "request_sync" and room.in_match:
            host_client = room.clients.get(room.host_id)
            if host_client:
                await host_client.send_json({
                    "type": "sync_requested",
                    "targetCid": None if client.id == room.host_id else client.id,
                    "slot": room.slot_of(client.id),
                })
            return

        if mtype == "shop_buy" and room.in_match:
            await self.broadcast(room, {
                "type": "action",
                "payload": {
                    "type": "shop_buy",
                    "slot": msg.get("slot"),
                    "kind": msg.get("kind"),
                    "index": msg.get("index"),
                },
            }, exclude_id=client.id)
            return

        if mtype == "shop_ready" and room.in_match:
            room.ready_clients.add(client.id)
            humans = room.human_client_ids()
            ready_cnt = sum(1 for hid in humans if hid in room.ready_clients)
            await self.broadcast(room, {
                "type": "shop_status",
                "ready": ready_cnt,
                "total": len(humans),
            })
            if ready_cnt >= len(humans) and len(humans) > 0:
                room.ready_clients.clear()
                room.round_num += 1
                seed = random.randint(1, 0x7FFFFFFF)
                await self.broadcast(room, {
                    "type": "next_round",
                    "round": room.round_num,
                    "seed": seed,
                })
            return

    async def leave_room(self, client: Client):
        code = client.room_code
        if not code:
            return
        client.room_code = None
        room = self.rooms.get(code)
        if not room:
            return
        room.clients.pop(client.id, None)
        room.ready_clients.discard(client.id)

        if not room.clients:
            self.rooms.pop(code, None)
            return

        # Reassign host if host left
        if room.host_id == client.id:
            room.host_id = next(iter(room.clients.keys()))

        if not room.in_match:
            # Remove leaving human from lobby slots (keep >=2 slots by adding a bot if needed)
            room.slots = [s for s in room.slots if s["client_id"] != client.id]
            while len(room.slots) < 2:
                used_cols = {s["col"] for s in room.slots}
                pick_col = next((c for c in DEFAULT_COLORS if c not in used_cols), DEFAULT_COLORS[len(room.slots) % 6])
                room.slots.append({"kind": "ai", "client_id": None, "name": f"Bot {len(room.slots)+1}", "col": pick_col, "dif": "normal"})
            await self.broadcast_lobby(room)
        else:
            # Mid-match disconnect: convert disconnected slot to AI so match never stalls
            slot_num = 0
            for idx, s in enumerate(room.slots):
                if s["client_id"] == client.id:
                    s["was_human"] = True
                    s["original_session_id"] = s.get("original_session_id") or s.get("session_id")
                    s["original_name"] = s.get("original_name") or s["name"]
                    s["kind"] = "ai"
                    s["client_id"] = None
                    slot_num = idx + 1
                    break
            for cid, c in list(room.clients.items()):
                await c.send_json({
                    "type": "peer_left",
                    "slot": slot_num,
                    "isHost": cid == room.host_id,
                })
            # Check if remaining humans are all ready in shop
            humans = room.human_client_ids()
            if humans and all(hid in room.ready_clients for hid in humans):
                room.ready_clients.clear()
                room.round_num += 1
                await self.broadcast(room, {
                    "type": "next_round",
                    "round": room.round_num,
                    "seed": random.randint(1, 0x7FFFFFFF),
                })

    # ==================== HTTP + WEBSOCKET PROTOCOL ====================

    async def handle_connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            raw_head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=15)
        except Exception:
            writer.close()
            return

        lines = raw_head.decode("latin1", errors="replace").split("\r\n")
        if not lines or len(lines[0].split(" ")) < 2:
            writer.close()
            return
        method, raw_path = lines[0].split(" ")[:2]
        headers = {}
        for ln in lines[1:]:
            if ":" in ln:
                k, v = ln.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        parsed = urllib.parse.urlparse(raw_path)
        path = parsed.path

        # WebSocket Upgrade on /ws
        if path == "/ws" and headers.get("upgrade", "").lower() == "websocket":
            ws_key = headers.get("sec-websocket-key", "")
            accept = base64.b64encode(hashlib.sha1((ws_key + WS_GUID).encode("ascii")).digest()).decode("ascii")
            resp = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            )
            writer.write(resp.encode("ascii"))
            await writer.drain()

            cid = f"c{self._next_cid}"
            self._next_cid += 1
            client = Client(cid, reader, writer)
            await self._ws_loop(client)
            return

        # Health / info JSON endpoint
        if path == "/api/health":
            body = json.dumps({"ok": True, "rooms": len(self.rooms)}).encode("utf-8")
            await self._send_http(writer, 200, "OK", "application/json", body)
            writer.close()
            return

        # Static file serving
        if method not in ("GET", "HEAD"):
            await self._send_http(writer, 405, "Method Not Allowed", "text/plain", b"Method Not Allowed")
            writer.close()
            return

        rel = path.lstrip("/") or "index.html"
        target = (ROOT_DIR / rel).resolve()
        # Prevent path traversal outside project directory
        if not str(target).startswith(str(ROOT_DIR)) or not target.is_file():
            await self._send_http(writer, 404, "Not Found", "text/plain", b"Not Found")
            writer.close()
            return

        mime, _ = mimetypes.guess_type(str(target))
        content_type = mime or "application/octet-stream"
        data = target.read_bytes()
        await self._send_http(writer, 200, "OK", content_type, b"" if method == "HEAD" else data, content_len=len(data))
        writer.close()

    async def _send_http(self, writer, status, reason, ctype, body, content_len=None):
        clen = len(body) if content_len is None else content_len
        head = (
            f"HTTP/1.1 {status} {reason}\r\n"
            f"Content-Type: {ctype}\r\n"
            f"Content-Length: {clen}\r\n"
            "Cache-Control: no-cache\r\n"
            "Connection: close\r\n\r\n"
        ).encode("ascii")
        writer.write(head + body)
        await writer.drain()

    async def _ws_loop(self, client: Client):
        try:
            while not client.closed:
                hdr = await client.reader.readexactly(2)
                b1, b2 = hdr[0], hdr[1]
                opcode = b1 & 0x0F
                masked = bool(b2 & 0x80)
                plen = b2 & 0x7F
                if plen == 126:
                    plen = struct.unpack("!H", await client.reader.readexactly(2))[0]
                elif plen == 127:
                    plen = struct.unpack("!Q", await client.reader.readexactly(8))[0]
                if plen > 2 * 1024 * 1024:
                    break
                mask = await client.reader.readexactly(4) if masked else None
                payload = bytearray(await client.reader.readexactly(plen))
                if masked and mask:
                    for i in range(plen):
                        payload[i] ^= mask[i & 3]

                if opcode == 0x8:  # Close
                    await client.send_ws_frame(0x8, b"")
                    break
                elif opcode == 0x9:  # Ping
                    await client.send_ws_frame(0xA, bytes(payload))
                elif opcode == 0x1:  # Text
                    try:
                        msg = json.loads(payload.decode("utf-8"))
                        if isinstance(msg, dict):
                            await self.handle_ws_message(client, msg)
                    except json.JSONDecodeError:
                        pass
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        finally:
            client.closed = True
            await self.leave_room(client)
            try:
                client.writer.close()
            except Exception:
                pass

    async def start(self):
        server = await asyncio.start_server(self.handle_connection, self.host, self.port)
        lan_ip = _get_lan_ip()
        print(f"Tank 3000 server running:")
        print(f"  Local: http://127.0.0.1:{self.port}/")
        if lan_ip:
            print(f"  LAN:   http://{lan_ip}:{self.port}/")
        async with server:
            await server.serve_forever()


def _get_lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return ""


def main():
    parser = argparse.ArgumentParser(description="Tank 3000 HTTP + WebSocket Multiplayer Server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    args = parser.parse_args()
    srv = TankServer(args.host, args.port)
    try:
        asyncio.run(srv.start())
    except KeyboardInterrupt:
        print("\nServer stopped.")


if __name__ == "__main__":
    main()
