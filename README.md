# Tank 3000

A 2D HTML5 Canvas + Web Audio artillery game for 2–5 players with local hotseat, serverless WebRTC P2P multiplayer, and LAN WebSocket hosting.

## Features
- **25Hz Artillery Simulation**: 550×400 vector stage, destructible terrain across 3 landscapes (`Mountains`, `Forest`, `Desert`, or `Random`) with falling trees, dynamic wind, gravity (`g = 9.81`), crater carving, fuel & hill climbing, fall damage, auto-parachutes, 4 shield tiers, upgrades, and teleport.
- **14 Weapons & 12 Specials**: Small Missile, Missile, Small Atom Bomb, Atom Bomb, Volcano Bomb, Shower, Hot Shower, Small/Normal/Large Ball V1 (downhill) & V2 (uphill), Air Strike, plus 12 defensive items and tank upgrades.
- **5 AI Difficulty Tiers**: `Very easy`, `Easy`, `Normal`, `Hard`, and `Very hard` bot opponents.
- **HiDPI Vector Graphics & Web Audio**: Crisp vector rendering, metallic blast-door transitions, and full sound effects.
- **Local Hotseat + Online P2P (WebRTC) + LAN WebSocket Multiplayer**:
  - **Local mode**: 2–5 players (Human or AI) taking turns on one machine with between-round shopping.
  - **Online P2P (WebRTC — Default)**: Zero backend server required. Works on any static host (**GitHub Pages**, **Netlify**, **Cloudflare Pages**, **Vercel**) using PeerJS with 4-letter room codes, direct invite links (`?room=CODE`), inline player & bot renaming, tab-switch reconnect resilience, live synced aiming & shots, and simultaneous between-round shopping.
  - **Local / LAN Server (WebSocket)**: Zero-dependency Python 3 server (`server.py`) for offline LAN play.

## Hosting Online (Static — No Server Required)
Deploy the repository directly as a static site (no build command, publish directory `.`):
- **GitHub Pages / Netlify / Cloudflare Pages / Vercel**: Serve the `main` branch root (`/`).

Open the site, click **Online Lobby**, keep **Online P2P (WebRTC)** selected, click **Create Room**, and share the **Copy Invite Link** (or 4-letter room code) with friends.

## Running Locally

```bash
python server.py
```

Then open **http://127.0.0.1:8000/** in your browser (supports both Online P2P and LAN WebSocket modes).

## Test Suite

```bash
python tests/test_suite.py
```

Verifies game assets, ES module links, and HTTP + WebSocket multiplayer server lifecycle.

## Controls
- **← / →**: Move tank (uses fuel) / flip Air Strike direction
- **↑ / ↓**: Rotate cannon angle (or drag the HUD angle slider)
- **PageUp / PageDown** or **W / S**: Adjust fire power (or drag the HUD power bar)
- **Q / E**: Cycle weapons (or click HUD arrows)
- **Space**: Fire (or click HUD Fire button)
- **Mouse**: Interactive HUD controls (Repair, Parachutes, Teleport, Shields flyout, Quality, Shop)
