import express from "express";
import multer from "multer";
import { del } from "@vercel/blob";
import { createServer } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { Server } from "socket.io";

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
  maxAge: 0
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

  const mediaUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
  await deleteRoomMovie(room);
  room.playback = {
    ...room.playback,
    paused: true,
    currentTime: 0,
    updatedAt: Date.now(),
    title: req.file.originalname,
    mediaUrl,
    pathname: null,
    localPath: req.file.path,
    source: "upload"
  };

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
      }
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
