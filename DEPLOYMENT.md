# Cinemate Deployment Guide

This app has two parts:

- Vercel hosts the React frontend and the Vercel Blob upload API.
- A realtime signaling server is still needed for rooms, chat, playback sync, and WebRTC signaling.

## Vercel Project

1. Open Vercel and sign in with GitHub.
2. Click **Add New...**.
3. Click **Project**.
4. Import `yash2006kr/cinemate`.
5. Fill the project settings like this:

| Field | Value |
| --- | --- |
| Project Name | `cinemate` |
| Framework Preset | `Vite` |
| Root Directory | `./` |
| Build Command | `pnpm build` |
| Output Directory | `dist` |
| Install Command | `pnpm install` |

6. Open **Environment Variables** before deploying.
7. Add `VITE_SIGNALING_URL`.
8. Set `VITE_SIGNALING_URL` to your realtime server URL.
9. Click **Deploy**.

For local development, `VITE_SIGNALING_URL` can be:

```bash
http://localhost:3001
```

For production, it must be an HTTPS/WSS-capable hosted backend URL, for example:

```bash
https://your-cinemate-server.onrender.com
```

## Vercel Blob

You already created the Blob store. Confirm these values:

| Field | Value |
| --- | --- |
| Store Name | `cinemate-movies` |
| Region | closest to your users, for example `Mumbai, India (South) - bom1` |
| Access | `Public` |
| Prefix | `BLOB` |
| Read-write token | enabled |

Vercel should automatically add Blob environment variables to the project.

## Heavy Movie Uploads

The app uses Vercel Blob client uploads in production:

- Files upload directly from the browser to Vercel Blob.
- Large uploads do not pass through a Vercel Function body.
- Upload progress is shown in the movie button.
- After upload, the room syncs the public Blob URL to everyone.

## Realtime Server

The local realtime server is:

```bash
pnpm dev:server
```

Vercel is not the best place for this current Socket.IO server. Deploy `server/index.js` to a long-running Node host such as Render, Railway, Fly.io, or a VPS, then put that URL in `VITE_SIGNALING_URL`.

The server needs:

```bash
pnpm install
node server/index.js
```

Set its port with:

```bash
PORT=3001
```

## First Production Test

1. Open the deployed Vercel URL.
2. Host a room.
3. Upload a small `.mp4` first.
4. Open the invite link in another browser or phone.
5. Confirm both tabs show the same movie.
6. Press play on the host.
7. Confirm the guest follows play, pause, and seek.

After that works, test a larger file.
