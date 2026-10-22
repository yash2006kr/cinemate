import express from "express";
import multer from "multer";
import { del } from "@vercel/blob";
import { createServer } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { Server } from "socket.io";
import { deleteR2Object, deleteR2Prefix, hasR2Config } from "./r2.js";
import { packageLocalMovie, packageR2Movie } from "./movie.js";

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST"]
  },
  pingInterval: 25000,
  pingTimeout: 60000
});

const rooms = new Map();
const uploadsDir = join(process.cwd(), "uploads");
const cleanupTimers = new Map();
const disconnectTimers = new Map();
const processingRooms = new Set();

if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, done) => {
    const roomCode = String(req.params.roomCode || "room").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const extension = extname(file.originalname) || ".mp4";
    done(null, `${roomCode}-${Date.now()}${extension}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 * 1024 }
});

app.use("/uploads", express.static(uploadsDir, {
  acceptRanges: true,
  immutable: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length");
  }
}));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "cinemate-realtime",
    rooms: rooms.size
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/rooms/:roomCode/movie", upload.single("movie"), async (req, res) => {
  const roomCode = String(req.params.roomCode || "").trim().toUpperCase();
  const room = rooms.get(roomCode);
  if (!room || !req.file) {
    res.status(404).json({ error: "Room or movie file not found" });
    return;
  }

  const outputFolder = `${roomCode}-${Date.now()}-hls`;
  const outputDir = join(uploadsDir, outputFolder);
  let prepared;
  try {
    prepared = await packageLocalMovie({
      inputPath: req.file.path,
      outputDir,
      mediaBaseUrl: `${req.protocol}://${req.get("host")}/uploads/${outputFolder}`
    });
    await unlink(req.file.path);
  } catch (error) {
    await unlink(req.file.path).catch(() => {});
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
    res.status(422).json({ error: error.message || "Could not prepare this movie for browser playback." });
    return;
  }

  await deleteRoomMovie(room);
  room.playback = {
    ...resetPlayback(),
    title: req.file.originalname,
    mediaUrl: prepared.mediaUrl,
    localHlsDir: outputDir,
    hlsTracks: prepared.hlsTracks,
    audioTrackIndex: prepared.audioTrackIndex,
    videoEncoded: prepared.encodedVideo,
    source: "hls"
  };
  room.processing = null;

  io.to(roomCode).emit("movie:ready", room.playback);
  io.to(roomCode).emit("room:update", roomSnapshot(roomCode));
  res.json(room.playback);
});

function code() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function roomSnapshot(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return null;
  return {
    code: roomCode,
    hostId: room.hostId,
    playback: room.playback,
    processing: room.processing || null,
    people: [...room.people.values()]
  };
}

function resetPlayback() {
  return {
    paused: true,
    currentTime: 0,
    updatedAt: Date.now(),
    title: "No movie selected",
    mediaUrl: null,
    pathname: null,
    localPath: null,
    r2Key: null,
    sourceR2Key: null,
    r2Prefix: null,
    localHlsDir: null,
    hlsTracks: [],
    audioTrackIndex: 0,
    videoEncoded: false,
    processing: null,
    source: null
  };
}

async function deleteRoomMovie(room) {
  const { playback } = room;
  const deleteTargets = [];
  if (playback?.pathname) deleteTargets.push(playback.pathname);
  else if (playback?.source === "blob" && playback?.mediaUrl) deleteTargets.push(playback.mediaUrl);

  if (deleteTargets.length > 0 && process.env.BLOB_READ_WRITE_TOKEN) {
    await del(deleteTargets).catch((error) => {
      console.warn("Blob cleanup failed:", error.message);
    });
  }

  if (playback?.localPath) {
    await unlink(playback.localPath).catch(() => {});
  }

  if (playback?.r2Key) {
    await deleteR2Object(playback.r2Key).catch((error) => {
      console.warn("R2 cleanup failed:", error.message);
    });
  }
  if (playback?.sourceR2Key) {
    await deleteR2Object(playback.sourceR2Key).catch((error) => {
      console.warn("Source movie cleanup failed:", error.message);
    });
  }
  if (playback?.r2Prefix) {
    await deleteR2Prefix(playback.r2Prefix).catch((error) => {
      console.warn("R2 movie cleanup failed:", error.message);
    });
  }
  if (playback?.localHlsDir) {
    await rm(playback.localHlsDir, { recursive: true, force: true }).catch(() => {});
  }
  if (room?.processingKey) {
    await deleteR2Object(room.processingKey).catch(() => {});
    room.processingKey = null;
  }
}

async function endRoom(roomCode, reason = "ended") {
  const room = rooms.get(roomCode);
  if (!room) return;
  await deleteRoomMovie(room);
  io.to(roomCode).emit("room:ended", { reason });
  io.in(roomCode).socketsLeave(roomCode);
  rooms.delete(roomCode);
  if (cleanupTimers.has(roomCode)) {
    clearTimeout(cleanupTimers.get(roomCode));
    cleanupTimers.delete(roomCode);
  }
}

function scheduleEmptyRoomCleanup(roomCode) {
  if (cleanupTimers.has(roomCode)) clearTimeout(cleanupTimers.get(roomCode));
  cleanupTimers.set(roomCode, setTimeout(() => {
    endRoom(roomCode, "empty").catch((error) => {
      console.warn("Empty room cleanup failed:", error.message);
    });
  }, 5000));
}

function clearDisconnectTimer(socketId) {
  if (!disconnectTimers.has(socketId)) return;
  clearTimeout(disconnectTimers.get(socketId));
  disconnectTimers.delete(socketId);
}

function findPersonByClientId(room, clientId) {
  if (!clientId) return null;
  for (const [socketId, person] of room.people) {
    if (person.clientId === clientId) return { socketId, person };
  }
  return null;
}

function reclaimClientSeat(room, nextSocketId, clientId) {
  const existing = findPersonByClientId(room, clientId);
  if (!existing || existing.socketId === nextSocketId) return { wasHost: false, previous: null };

  clearDisconnectTimer(existing.socketId);
  room.people.delete(existing.socketId);
  const oldSocket = io.sockets.sockets.get(existing.socketId);
  if (oldSocket) {
    for (const joinedRoom of oldSocket.rooms) {
      if (joinedRoom !== oldSocket.id) oldSocket.leave(joinedRoom);
    }
  }

  const wasHost = room.hostId === existing.socketId || existing.person.host;
  if (wasHost) room.hostId = nextSocketId;
  return { wasHost, previous: existing.person };
}

function removePersonFromRoom(socketId, roomCode, reason = "left") {
  const room = rooms.get(roomCode);
  if (!room?.people.has(socketId)) return;

  clearDisconnectTimer(socketId);
  const leavingPerson = room.people.get(socketId);
  const wasHost = room.hostId === socketId;
  room.people.delete(socketId);

  if (wasHost) {
    const next = room.people.keys().next().value;
    room.hostId = next || null;
    if (next) {
      const person = room.people.get(next);
      room.people.set(next, { ...person, host: true });
    }
  }

  io.to(socketId).emit("room:left", { reason });
  io.in(socketId).socketsLeave(roomCode);

  if (room.people.size === 0) scheduleEmptyRoomCleanup(roomCode);
  else {
    io.to(roomCode).emit("presence:left", {
      id: socketId,
      name: leavingPerson?.name || "Friend",
      reason
    });
    io.to(roomCode).emit("room:update", roomSnapshot(roomCode));
  }
}

function ensureRoom(roomCode, hostId) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      hostId,
      people: new Map(),
      playback: {
        ...resetPlayback()
      },
      processing: null,
      processingKey: null
    });
  }
  return rooms.get(roomCode);
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ name, clientId }, reply) => {
    const roomCode = code();
    const room = ensureRoom(roomCode, socket.id);
    if (cleanupTimers.has(roomCode)) {
      clearTimeout(cleanupTimers.get(roomCode));
      cleanupTimers.delete(roomCode);
    }
    room.people.set(socket.id, {
      id: socket.id,
      clientId,
      name: name || "Host",
      avatar: (name || "H").slice(0, 1).toUpperCase(),
      audio: false,
      video: false,
      host: true
    });
    socket.join(roomCode);
    reply?.(roomSnapshot(roomCode));
    io.to(roomCode).emit("room:update", roomSnapshot(roomCode));
  });

  socket.on("room:join", ({ roomCode, name, clientId }, reply) => {
    const normalized = String(roomCode || "").trim().toUpperCase();
    const room = rooms.get(normalized);
    if (!room) {
      reply?.({ error: "Room not found" });
      return;
    }
    const { wasHost, previous } = reclaimClientSeat(room, socket.id, clientId);
    const host = wasHost || socket.id === room.hostId;
    room.people.set(socket.id, {
      id: socket.id,
      clientId,
      name: name || previous?.name || "Friend",
      avatar: (name || previous?.name || "F").slice(0, 1).toUpperCase(),
      audio: previous?.audio || false,
      video: previous?.video || false,
      host
    });
    socket.join(normalized);
    if (cleanupTimers.has(normalized)) {
      clearTimeout(cleanupTimers.get(normalized));
      cleanupTimers.delete(normalized);
    }
    reply?.(roomSnapshot(normalized));
    if (!previous) {
      socket.to(normalized).emit("presence:joined", {
        id: socket.id,
        name: name || "Friend"
      });
    }
    io.to(normalized).emit("room:update", roomSnapshot(normalized));
  });

  socket.on("presence:update", ({ roomCode, patch }) => {
    const room = rooms.get(roomCode);
    const person = room?.people.get(socket.id);
    if (!room || !person) return;
    room.people.set(socket.id, { ...person, ...patch });
    io.to(roomCode).emit("room:update", roomSnapshot(roomCode));
  });

  socket.on("playback:update", ({ roomCode, playback }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const previousPlayback = room.playback;
    room.playback = {
      ...room.playback,
      ...playback,
      updatedAt: Date.now()
    };
    if (playback.mediaUrl && playback.mediaUrl !== previousPlayback.mediaUrl) {
      deleteRoomMovie({ playback: previousPlayback }).catch(() => {});
    }
    socket.to(roomCode).emit("playback:sync", room.playback);
    io.to(roomCode).emit("room:update", roomSnapshot(roomCode));
  });

  socket.on("movie:process", async ({ roomCode, key, title }, reply) => {
    const room = rooms.get(roomCode);
    const safeTitle = String(title || "Movie").slice(0, 180);
    const validKey = typeof key === "string" && key.startsWith(`rooms/${roomCode}/`) && !key.includes("..");
    if (!room || room.hostId !== socket.id || !validKey || !hasR2Config()) {
      reply?.({ error: "This movie upload could not be authorized or storage is not configured." });
      return;
    }
    if (processingRooms.has(roomCode)) {
      reply?.({ error: "A movie is already being prepared for this room." });
      return;
    }

    processingRooms.add(roomCode);
    room.processingKey = key;
    room.processing = { status: "processing", title: safeTitle, progress: 0, error: null };
    io.to(roomCode).emit("room:update", roomSnapshot(roomCode));
    reply?.({ ok: true });

    const previousPlayback = room.playback;
    let lastProgress = -1;
    try {
      const prepared = await packageR2Movie({
        roomCode,
        key,
        onProgress: (progress) => {
          const nextProgress = Math.max(0, Math.min(100, progress));
          if (nextProgress === 100 || nextProgress >= lastProgress + 3) {
            lastProgress = nextProgress;
            room.processing = { status: "processing", title: safeTitle, progress: nextProgress, error: null };
            io.to(roomCode).emit("room:update", roomSnapshot(roomCode));
          }
        }
      });
      if (rooms.get(roomCode) !== room) {
        await deleteR2Prefix(prepared.r2Prefix);
        await deleteR2Object(key);
        return;
      }

      room.playback = {
        ...resetPlayback(),
        title: safeTitle,
        mediaUrl: prepared.mediaUrl,
        sourceR2Key: key,
        r2Prefix: prepared.r2Prefix,
        hlsTracks: prepared.hlsTracks,
        audioTrackIndex: prepared.audioTrackIndex,
        videoEncoded: prepared.encodedVideo,
        source: "hls"
      };
      room.processing = null;
      try {
        await deleteR2Object(key);
        room.playback.sourceR2Key = null;
      } catch (error) {
        console.warn("Original movie cleanup failed:", error.message);
      }
      room.processingKey = null;
      io.to(roomCode).emit("movie:ready", room.playback);
      io.to(roomCode).emit("room:update", roomSnapshot(roomCode));
      deleteRoomMovie({ playback: previousPlayback }).catch((error) => console.warn("Previous movie cleanup failed:", error.message));
    } catch (error) {
      await deleteR2Object(key).catch(() => {});
      room.processingKey = null;
      room.processing = {
        status: "error",
        title: safeTitle,
        progress: 0,
        error: error.message || "Could not prepare this movie for browser playback."
      };
      io.to(roomCode).emit("room:update", roomSnapshot(roomCode));
    } finally {
      processingRooms.delete(roomCode);
    }
  });

  socket.on("audio-track:update", ({ roomCode, trackIndex }) => {
    const room = rooms.get(roomCode);
    const index = Number(trackIndex);
    if (!room || room.hostId !== socket.id || room.playback.source !== "hls") return;
    if (!Number.isInteger(index) || index < 0 || index >= (room.playback.hlsTracks || []).length) return;
    room.playback.audioTrackIndex = index;
    io.to(roomCode).emit("audio-track:sync", index);
    io.to(roomCode).emit("room:update", roomSnapshot(roomCode));
  });

  socket.on("room:end", async ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    await endRoom(roomCode, "host-ended");
  });

  socket.on("room:leave", ({ roomCode }) => {
    removePersonFromRoom(socket.id, roomCode, "left");
  });

  socket.on("room:kick", ({ roomCode, personId }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id || personId === socket.id) return;
    removePersonFromRoom(personId, roomCode, "kicked");
  });

  socket.on("chat:send", ({ roomCode, message }) => {
    const room = rooms.get(roomCode);
    const person = room?.people.get(socket.id);
    if (!room || !person || !message?.trim()) return;
    io.to(roomCode).emit("chat:new", {
      id: crypto.randomUUID(),
      name: person.name,
      avatar: person.avatar,
      message: message.trim(),
      at: new Date().toISOString()
    });
  });

  socket.on("reaction:send", ({ roomCode, reaction }) => {
    const room = rooms.get(roomCode);
    const person = room?.people.get(socket.id);
    if (!room || !person) return;
    io.to(roomCode).emit("reaction:new", {
      id: crypto.randomUUID(),
      name: person.name,
      reaction,
      x: Math.random() * 72 + 14
    });
  });

  socket.on("webrtc:offer", ({ roomCode, to, channel, description }) => {
    if (!rooms.has(roomCode) || !to) return;
    io.to(to).emit("webrtc:offer", {
      from: socket.id,
      channel,
      description
    });
  });

  socket.on("webrtc:answer", ({ roomCode, to, channel, description }) => {
    if (!rooms.has(roomCode) || !to) return;
    io.to(to).emit("webrtc:answer", {
      from: socket.id,
      channel,
      description
    });
  });

  socket.on("webrtc:ice", ({ roomCode, to, channel, candidate }) => {
    if (!rooms.has(roomCode) || !to || !candidate) return;
    io.to(to).emit("webrtc:ice", {
      from: socket.id,
      channel,
      candidate
    });
  });

  socket.on("disconnect", () => {
    for (const [roomCode, room] of rooms) {
      if (!room.people.has(socket.id)) continue;
      clearDisconnectTimer(socket.id);
      disconnectTimers.set(socket.id, setTimeout(() => {
        removePersonFromRoom(socket.id, roomCode, "disconnected");
      }, 20000));
    }
  });
});

async function cleanupAllRooms() {
  await Promise.all([...rooms.keys()].map((roomCode) => endRoom(roomCode, "server-shutdown")));
}

process.on("SIGTERM", () => {
  cleanupAllRooms().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  cleanupAllRooms().finally(() => process.exit(0));
});

const port = process.env.PORT || 3001;
const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => {
  console.log(`Cinemate realtime server listening on ${host}:${port}`);
  if (process.env.RENDER_EXTERNAL_URL) {
    console.log(`Public URL: ${process.env.RENDER_EXTERNAL_URL}`);
  }
});
