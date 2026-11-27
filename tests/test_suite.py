import asyncio
import base64
import json
import os
import re
import struct
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import server as srv_mod


def test_assets():
    print("[1/3] Checking game assets...")
    assets_json = ROOT / "assets" / "game-assets.json"
    assert assets_json.is_file(), "Missing game-assets.json"
    data = json.loads(assets_json.read_text(encoding="utf-8"))

    assert data["stage"] == {"w": 550, "h": 400, "fps": 25, "bg": "#000099"}
    assert len(data["shapes"]) == 124, f"Expected 124 shapes/morphs, got {len(data['shapes'])}"
    assert len(data["sprites"]) == 144, f"Expected 144 sprites, got {len(data['sprites'])}"
    assert len(data["buttons"]) == 46, f"Expected 46 buttons, got {len(data['buttons'])}"
    assert len(data["bitmaps"]) == 3, f"Expected 3 bitmaps, got {len(data['bitmaps'])}"
    assert len(data["sounds"]) == 7, f"Expected 7 sounds, got {len(data['sounds'])}"

    required_exports = [
        "tank", "hlaven", "krajina1", "krajina2", "krajina3", "strom_1", "strom_2",
        "panel", "clona", "buymenu", "weapon", "special", "score_tab", "blk",
        "parachute", "teleport_a", "weak_sh", "shield_sh", "strong_sh", "super_sh",
        "bmissile", "missile", "bnuke", "nuke", "funky", "mirv", "death",
        "broller", "roller", "hroller", "broller2", "roller2", "hroller2", "astrike",
        "astrikecur", "par", "repair", "fuel", "sshield", "shield", "stshield", "spshield",
        "teleport", "upenergy", "uparmor", "upmove", "uphill",
    ]
    for sym in required_exports:
        assert sym in data["exports"], f"Missing export symbol: {sym}"

    # Verify embedded outline font metrics
    motor = data["fonts"]["243"]
    assert motor["name"] == "Motor" and len(motor["glyphs"]) == 224
    assert motor["ascent"] == 970 and len(motor["advances"]) == 224

    # Verify bitmaps via PIL
    expected_dims = {"230": (276, 400), "237": (276, 400), "318": (550, 400)}
    for bid, dims in expected_dims.items():
        img_path = ROOT / data["bitmaps"][bid]["file"]
        assert img_path.is_file(), f"Missing bitmap file {img_path}"
        with Image.open(img_path) as im:
            assert im.size == dims, f"Bitmap {bid} expected {dims}, got {im.size}"

    # Verify all 7 MP3 files are non-empty and have valid MP3 frame sync
    for sid, sinfo in data["sounds"].items():
        sp = ROOT / sinfo["file"]
        assert sp.is_file(), f"Missing sound file {sp}"
        raw = sp.read_bytes()
        assert len(raw) > 200, f"Sound {sid} unexpectedly small: {len(raw)}"
        assert raw[0] == 0xFF and (raw[1] & 0xE0) == 0xE0, f"Sound {sid} bad MP3 header: {raw[:4].hex()}"

    print("  OK: 124 shapes/morphs, 144 sprites, 3 bitmaps, 7 MP3s verified.")


def test_js_module_links():
    print("[2/3] Checking JS ES module imports & exports...")
    js_files = sorted((ROOT / "js").glob("*.js"))
    assert len(js_files) == 11, f"Expected 11 JS modules, got {len(js_files)}"
    for jf in js_files:
        txt = jf.read_text(encoding="utf-8")
        for m in re.finditer(r"import\s+\{([^}]+)\}\s+from\s+'(\./[^']+)'", txt):
            syms = [s.strip().split(" as ")[0].strip() for s in m.group(1).split(",") if s.strip()]
            target = (jf.parent / m.group(2)).resolve()
            assert target.is_file(), f"{jf.name} imports missing module {m.group(2)}"
            target_txt = target.read_text(encoding="utf-8")
            for sym in syms:
                pat = rf"export\s+(?:const|let|var|function|class)\s+{re.escape(sym)}\b"
                assert re.search(pat, target_txt), f"{jf.name} imports missing symbol '{sym}' from {target.name}"
    assert (ROOT / "js" / "vendor" / "peerjs.min.js").is_file(), "Missing vendored PeerJS library"
    print(f"  OK: All {len(js_files)} JS ES modules + PeerJS P2P vendor library have valid imports/exports.")


class TestWSClient:
    def __init__(self, reader, writer):
        self.reader = reader
        self.writer = writer

    @classmethod
    async def connect(cls, host, port):
        reader, writer = await asyncio.open_connection(host, port)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET /ws HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        writer.write(req.encode("ascii"))
        await writer.drain()
        resp = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5)
        assert b"101 Switching Protocols" in resp, f"WS upgrade failed: {resp!r}"
        return cls(reader, writer)

    async def send_json(self, obj):
        payload = json.dumps(obj).encode("utf-8")
        mask = os.urandom(4)
        header = bytearray([0x81])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        else:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", n))
        header.extend(mask)
        masked = bytes(payload[i] ^ mask[i & 3] for i in range(n))
        self.writer.write(bytes(header) + masked)
        await self.writer.drain()

    async def recv_json(self, timeout=5.0):
        hdr = await asyncio.wait_for(self.reader.readexactly(2), timeout=timeout)
        plen = hdr[1] & 0x7F
        if plen == 126:
            plen = struct.unpack("!H", await self.reader.readexactly(2))[0]
        elif plen == 127:
            plen = struct.unpack("!Q", await self.reader.readexactly(8))[0]
        data = await self.reader.readexactly(plen)
        return json.loads(data.decode("utf-8"))

    async def close(self):
        self.writer.close()
        try:
            await self.writer.wait_closed()
        except Exception:
            pass


async def http_get(host, port, path):
    reader, writer = await asyncio.open_connection(host, port)
    writer.write(f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode("ascii"))
    await writer.drain()
    raw = await asyncio.wait_for(reader.read(), timeout=5)
    writer.close()
    head, _, body = raw.partition(b"\r\n\r\n")
    status_line = head.split(b"\r\n")[0].decode("ascii")
    return status_line, head.decode("latin1"), body


async def test_server_e2e():
    print("[3/3] Testing HTTP + WebSocket multiplayer server end-to-end...")
    host, port = "127.0.0.1", 18765
    srv = srv_mod.TankServer(host, port)
    server = await asyncio.start_server(srv.handle_connection, host, port)

    try:
        st, hdr, body = await http_get(host, port, "/")
        assert "200 OK" in st and b"game-canvas" in body
        st, hdr, body = await http_get(host, port, "/js/main.js")
        assert "200 OK" in st and "javascript" in hdr.lower()
        st, hdr, body = await http_get(host, port, "/api/health")
        assert "200 OK" in st and json.loads(body)["ok"] is True
        st, _, _ = await http_get(host, port, "/../../Windows/win.ini")
        assert "404" in st, f"Path traversal not rejected: {st}"

        c1 = await TestWSClient.connect(host, port)
        c2 = await TestWSClient.connect(host, port)

        await c1.send_json({"type": "create_room", "name": "Alice"})
        lob1 = await c1.recv_json()
        assert lob1["type"] == "lobby_state" and lob1["isHost"] is True
        code = lob1["code"]
        assert len(code) == 4 and len(lob1["slots"]) == 2

        await c1.send_json({"type": "host_config", "action": "set_krajina", "krajina": 2})
        lob1 = await c1.recv_json()
        assert lob1["krajina"] == 2

        await c1.send_json({"type": "host_config", "action": "set_bot_name", "index": 1, "name": "Terminator"})
        lob1 = await c1.recv_json()
        assert lob1["slots"][1]["name"] == "Terminator"

        await c2.send_json({"type": "join_room", "code": code, "name": "Bob"})
        lob1 = await c1.recv_json()
        lob2 = await c2.recv_json()
        assert len(lob1["slots"]) == 3
        assert lob2["isHost"] is False and lob2["mySlot"] == 3

        await c2.send_json({"type": "update_profile", "name": "Bobby"})
        lob1 = await c1.recv_json()
        lob2 = await c2.recv_json()
        assert lob1["slots"][2]["name"] == "Bobby" and lob2["slots"][2]["name"] == "Bobby"

        await c1.send_json({"type": "start_match"})
        ms1 = await c1.recv_json()
        ms2 = await c2.recv_json()
        assert ms1["type"] == "match_start" and ms2["type"] == "match_start"
        assert ms1["seed"] == ms2["seed"] and ms1["krajina"] == 2
        assert ms1["mySlot"] == 1 and ms2["mySlot"] == 3
        assert ms1["isHost"] is True and ms2["isHost"] is False

        await c1.send_json({"type": "aim", "payload": {"tankNumber": 1, "x": 120, "y": 250, "rotace": 130, "power": 62, "fuel": 240, "gun": 4}})
        aim2 = await c2.recv_json()
        assert aim2["type"] == "aim" and aim2["payload"]["rotace"] == 130

        await c1.send_json({"type": "action", "payload": {"type": "fire", "tankNumber": 1, "gun": 4}})
        act2 = await c2.recv_json()
        assert act2["type"] == "action" and act2["payload"]["type"] == "fire"

        await c1.send_json({"type": "shop_buy", "slot": 1, "kind": "weapon", "index": 2})
        sb2 = await c2.recv_json()
        assert sb2["type"] == "action" and sb2["payload"]["type"] == "shop_buy" and sb2["payload"]["index"] == 2

        await c1.send_json({"type": "shop_ready"})
        st1 = await c1.recv_json()
        st2 = await c2.recv_json()
        assert st1["type"] == "shop_status" and st1["ready"] == 1 and st1["total"] == 2
        assert st2["ready"] == 1

        await c2.send_json({"type": "shop_ready"})
        m1a = await c1.recv_json()
        m1b = await c1.recv_json()
        m2a = await c2.recv_json()
        m2b = await c2.recv_json()
        assert m1a["type"] == "shop_status" and m1a["ready"] == 2
        assert m1b["type"] == "next_round" and m2b["type"] == "next_round"
        assert m1b["seed"] == m2b["seed"] and m1b["round"] == 2

        await c2.close()
        pl = await c1.recv_json()
        assert pl["type"] == "peer_left" and pl["slot"] == 3 and pl["isHost"] is True

        await c1.close()
        await asyncio.sleep(0.05)
        assert code not in srv.rooms, "Empty room was not cleaned up"
        print("  OK: HTTP static files, security, rooms, renaming, live sync, shop, and disconnect recovery passed!")
    finally:
        server.close()
        await server.wait_closed()


def main():
    test_assets()
    test_js_module_links()
    asyncio.run(test_server_e2e())
    print("\nALL TESTS PASSED!")


if __name__ == "__main__":
    main()
