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

On Render, do not create `PORT` manually. Render provides it automatically.

Add these environment variables to Render too, so the realtime server can delete uploaded movies when rooms end or everyone leaves:

```bash
BLOB_READ_WRITE_TOKEN=your_vercel_blob_read_write_token
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_access_key_id
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
R2_BUCKET=cinemate-movies
R2_PUBLIC_URL=https://your-public-r2-bucket-url
```

You can copy the value from Vercel:

1. Open the Vercel project.
2. Go to **Settings**.
3. Open **Environment Variables**.
4. Find `BLOB_READ_WRITE_TOKEN`.
5. Copy it into Render.

## Cloudflare R2 Movie Storage

Use Cloudflare R2 for real movie uploads. Vercel Blob Hobby can hit operation limits quickly with large watch-party testing.

1. Open Cloudflare Dashboard.
2. Go to **R2 Object Storage**.
3. Click **Create bucket**.
4. Name it `cinemate-movies`.
5. Keep the default location/storage settings and create it.
6. Open the bucket.
7. Go to **Settings**.
8. Enable a public bucket URL. Cloudflare may call this **Public Development URL** or public access. Copy the public URL.
9. Go to **Manage API Tokens** for R2.
10. Create an API token with **Object Read & Write** permission for only the `cinemate-movies` bucket.
11. Copy the **Access Key ID** and **Secret Access Key** immediately.
12. Find your Cloudflare **Account ID** from the R2 overview or dashboard sidebar.

Add these environment variables in **Vercel > cinemate > Settings > Environment Variables** for Production and Preview:

```bash
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_access_key_id
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
R2_BUCKET=cinemate-movies
R2_PUBLIC_URL=https://your-public-r2-bucket-url
```

Add the same R2 variables in **Render > cinemate-server > Environment** so the server can delete uploaded movies after rooms end.

After redeploying Vercel, test the R2 configuration by opening:

```text
https://your-vercel-app.vercel.app/api/r2/status
```

It should return `"ok": true`. If it lists missing variables, add those variables in Vercel and redeploy again.

Set this CORS policy on the R2 bucket so browser uploads work:

```json
[
  {
    "AllowedOrigins": [
      "https://your-vercel-app.vercel.app",
      "http://localhost:5173"
    ],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Replace `https://your-vercel-app.vercel.app` with your actual Cinemate Vercel URL.

## Cleanup Uploaded Movies

The app deletes the active uploaded movie when:

- the host clicks **End Room**;
- everyone leaves or closes their tabs;
- the realtime server shuts down cleanly.

To delete old test uploads manually, run:

```bash
pnpm blob:cleanup
```

That command needs `BLOB_READ_WRITE_TOKEN` in the shell environment.

On Windows PowerShell:

```powershell
$env:BLOB_READ_WRITE_TOKEN="paste-token-here"
pnpm blob:cleanup
```

You can also delete old files from Vercel:

1. Open Vercel.
2. Go to **Storage**.
3. Open `cinemate-movies`.
4. Open the `rooms/` folder.
5. Select the old test files.
6. Click **Delete**.

## 1GB+ Movie Uploads

Use Cloudflare R2 for 1GB+ movie uploads.

Use these rules:

- Prefer `.mp4` with H.264 video and AAC audio.
- Avoid `.mkv` for now; many browsers cannot play MKV directly.
- Keep the R2 bucket public for simple browser playback.
- Use a strong connection before uploading big files.
- Test with a 50-100MB MP4 before trying a full 1GB+ movie.

Large uploads go directly from the browser to Cloudflare R2 using a temporary signed upload URL, so they do not pass through the Vercel Function body limit.

## First Production Test

1. Open the deployed Vercel URL.
2. Host a room.
3. Upload a small `.mp4` first.
4. Open the invite link in another browser or phone.
5. Confirm both tabs show the same movie.
6. Press play on the host.
7. Confirm the guest follows play, pause, and seek.

After that works, test a larger file.
