# Cinemate

A browser watch-party app for friends who already have the same movie file.

## V1

- Create a room with a short code and invite link.
- Host uploads one movie file and everyone streams the same served video URL.
- Play, pause, seek, and resync over realtime sockets.
- Chat and emoji reactions.
- Screen-share fallback with browser audio capture when supported.
- Presence list with mic/camera state toggles.
- Peer camera/mic tiles over WebRTC.

## Run

```bash
pnpm install
pnpm dev
```

Open `http://localhost:5173`.

## Deploy

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full Vercel + Render + Cloudflare R2 setup.

## Roadmap

- WebRTC camera/mic streams using an SFU such as LiveKit or mediasoup.
- Host upload mode with FFmpeg packaging to HLS/DASH and CDN delivery.
- Subtitle upload and shared subtitle offset controls.
- Host handoff, ready checks, intermission mode, and watch history.
