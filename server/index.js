import express from "express";
import multer from "multer";
import { createServer } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { Server } from "socket.io";

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();
const uploadsDir = join(process.cwd(), "uploads");

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

app.post("/api/rooms/:roomCode/movie", upload.single("movie"), (req, res) => {
  const roomCode = String(req.params.roomCode || "").trim().toUpperCase();
  const room = rooms.get(roomCode);
  if (!room || !req.file) {
    res.status(404).json({ error: "Room or movie file not found" });
    return;
  }

  const mediaUrl = `/uploads/${req.file.filename}`;
  room.playback = {
    ...room.playback,
    paused: true,
    currentTime: 0,
    updatedAt: Date.now(),
    title: req.file.originalname,
    mediaUrl,
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

function ensureRoom(roomCode, hostId) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      hostId,
      people: new Map(),
      playback: {
        paused: true,
        currentTime: 0,
        updatedAt: Date.now(),
        title: "No movie selected",
        mediaUrl: null,
        source: null
      }
    });
  }
  return rooms.get(roomCode);
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ name }, reply) => {
    const roomCode = code();
    const room = ensureRoom(roomCode, socket.id);
    room.people.set(socket.id, {
      id: socket.id,
      name: name || "Host",
      avatar: (name || "H").slice(0, 1).toUpperCase(),
      audio: true,
      video: false,
      host: true
    });
    socket.join(roomCode);
    reply?.(roomSnapshot(roomCode));
    io.to(roomCode).emit("room:update", roomSnapshot(roomCode));
  });

  socket.on("room:join", ({ roomCode, name }, reply) => {
    const normalized = String(roomCode || "").trim().toUpperCase();
    const room = rooms.get(normalized);
    if (!room) {
      reply?.({ error: "Room not found" });
      return;
    }
    room.people.set(socket.id, {
      id: socket.id,
      name: name || "Friend",
      avatar: (name || "F").slice(0, 1).toUpperCase(),
      audio: true,
      video: false,
      host: socket.id === room.hostId
    });
    socket.join(normalized);
    reply?.(roomSnapshot(normalized));
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
    room.playback = {
      ...room.playback,
      ...playback,
      updatedAt: Date.now()
    };
    socket.to(roomCode).emit("playback:sync", room.playback);
    io.to(roomCode).emit("room:update", roomSnapshot(roomCode));
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
      const wasHost = room.hostId === socket.id;
      room.people.delete(socket.id);
      if (wasHost) {
        const next = room.people.keys().next().value;
        room.hostId = next || null;
        if (next) {
          const person = room.people.get(next);
          room.people.set(next, { ...person, host: true });
        }
      }
      if (room.people.size === 0) rooms.delete(roomCode);
      else io.to(roomCode).emit("room:update", roomSnapshot(roomCode));
    }
  });
});

const port = process.env.PORT || 3001;
server.listen(port, () => {
  console.log(`Cinemate realtime server listening on http://localhost:${port}`);
});
