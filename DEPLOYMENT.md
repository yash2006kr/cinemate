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

## Existing Vercel Blob Store

You already created the Blob store. Confirm these values:

| Field | Value |
| --- | --- |
| Store Name | `cinemate-movies` |
| Region | closest to your users, for example `Mumbai, India (South) - bom1` |
| Access | `Public` |
| Prefix | `BLOB` |
| Read-write token | enabled |

Vercel should automatically add Blob environment variables to the project.
The current movie upload flow uses Cloudflare R2; this Blob store is retained for cleanup of any older test uploads.

## MKV And Multiple Audio Tracks

Production movie uploads go directly from the browser to Cloudflare R2. The Render realtime service downloads each uploaded file, probes its streams with FFprobe, and packages it as HLS with separate audio renditions. The browser uses HLS.js on MSE browsers and native HLS on Safari. The host selects the track; the room synchronizes that choice.

- H.264 8-bit 4:2:0 video is copied without re-encoding.
- Other video codecs or pixel formats are converted to H.264 for broad browser playback. This takes longer and changes the video encoding.
- Audio tracks are converted to AAC so Chrome, Firefox, Edge, and Safari can play them.
- The source upload is deleted after successful packaging. HLS outputs are deleted when the room ends or becomes empty.
- R2 single-request uploads are limited to 5GB. Larger files need multipart upload support, which this app does not currently implement.

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

Keep the repository's `pnpm-workspace.yaml` build permission for `ffmpeg-static` enabled. Render installs the FFmpeg binary during dependency installation; the Windows ARM64 development machine may not have a bundled FFmpeg binary, so local MKV processing requires FFmpeg on PATH or `FFMPEG_PATH`/`FFPROBE_PATH` set to installed binaries.

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

For large movies, attach a paid Render persistent disk to the realtime web service with mount path `/var/data`, then add this Render environment variable:

```bash
CINEMATE_TMP_DIR=/var/data/cinemate-tmp
```

Packaging needs temporary room for the downloaded source plus generated HLS output. Budget at least about 2x the movie size, with more headroom for HEVC or other video that needs conversion. Render Free services have ephemeral storage and cannot attach a persistent disk, so they are not suitable for preparing 1GB+ movies reliably.

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

Set this CORS policy on the R2 bucket so browser uploads and HLS playback work. Origins must not end in `/`:

```json
[
  {
    "AllowedOrigins": [
      "https://your-vercel-app.vercel.app",
      "http://localhost:5173"
    ],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Accept-Ranges", "Content-Range", "Content-Length"],
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

## Large Movie Notes

R2 uploads bypass Vercel's function body limit, but the Render service still has to package the video after upload. Use a Render disk sized for the temporary working space described above, and leave the movie tab open until the **Preparing** progress finishes. A 1GB movie can take several minutes; a non-H.264 source can take substantially longer.

## First Production Test

1. Open the deployed Vercel URL.
2. Host a room.
3. Upload a small `.mp4` first.
4. Open the invite link in another browser or phone.
5. Confirm both tabs show the same movie.
6. Press play on the host.
7. Confirm the guest follows play, pause, and seek.

After that works, test a larger file.
