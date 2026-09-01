import { createR2Upload, hasR2Config } from "../../server/r2.js";

const maxUploadBytes = 8 * 1024 * 1024 * 1024;

function safeName(name = "movie.mp4") {
  return name.replace(/[^\w.\-() ]/g, "_").slice(0, 180);
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!hasR2Config()) {
    response.status(501).json({ error: "Cloudflare R2 is not configured." });
    return;
  }

  try {
    const body = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
    const roomCode = String(body?.roomCode || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const fileName = safeName(body?.fileName);
    const contentType = body?.contentType || "application/octet-stream";
    const size = Number(body?.size || 0);

    if (!roomCode) {
      response.status(400).json({ error: "Missing room code." });
      return;
    }

    if (!Number.isFinite(size) || size <= 0 || size > maxUploadBytes) {
      response.status(400).json({ error: "Movie must be 8GB or smaller." });
      return;
    }

    const key = `rooms/${roomCode}/${Date.now()}-${fileName}`;
    response.status(200).json(await createR2Upload({ key, contentType }));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}
