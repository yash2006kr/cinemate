import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io } from "socket.io-client";
import {
  Camera,
  CameraOff,
  Clapperboard,
  Copy,
  Link,
  MessageCircle,
  Mic,
  MicOff,
  MonitorUp,
  Pause,
  Play,
  Send,
  Sparkles,
  Upload,
  Users
} from "lucide-react";
import "./styles.css";

const socket = io("http://localhost:3001", { autoConnect: true });
const reactions = ["🔥", "😂", "😱", "😭", "👏", "🍿"];

function syncTime(playback) {
  if (playback.paused) return playback.currentTime;
  return playback.currentTime + (Date.now() - playback.updatedAt) / 1000;
}

function App() {
  const [name, setName] = useState(localStorage.getItem("cinemate:name") || "");
  const [joinCode, setJoinCode] = useState("");
  const [room, setRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState("");
  const [localUrl, setLocalUrl] = useState("");
  const [screenStream, setScreenStream] = useState(null);
  const [floating, setFloating] = useState([]);
  const [device, setDevice] = useState({ audio: true, video: false });
  const videoRef = useRef(null);
  const screenRef = useRef(null);
  const syncing = useRef(false);

  const isHost = room?.hostId === socket.id;
  const invite = room ? `${window.location.origin}?room=${room.code}` : "";

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get("room");
    if (roomParam) setJoinCode(roomParam.toUpperCase());
  }, []);

  useEffect(() => {
    socket.on("room:update", setRoom);
    socket.on("chat:new", (next) => setMessages((current) => [...current, next]));
    socket.on("reaction:new", (next) => {
      setFloating((current) => [...current, next]);
      window.setTimeout(() => {
        setFloating((current) => current.filter((item) => item.id !== next.id));
      }, 2200);
    });
    socket.on("playback:sync", (playback) => {
      const player = videoRef.current;
      if (!player) return;
      syncing.current = true;
      const target = syncTime(playback);
      if (Math.abs(player.currentTime - target) > 0.45) player.currentTime = target;
      if (playback.paused) player.pause();
      else player.play().catch(() => {});
      window.setTimeout(() => {
        syncing.current = false;
      }, 250);
    });
    return () => {
      socket.off("room:update");
      socket.off("chat:new");
      socket.off("reaction:new");
      socket.off("playback:sync");
    };
  }, []);

  useEffect(() => {
    if (screenRef.current && screenStream) {
      screenRef.current.srcObject = screenStream;
    }
  }, [screenStream]);

  const people = useMemo(() => room?.people || [], [room]);

  function rememberName() {
    const clean = name.trim() || "Movie Buddy";
    localStorage.setItem("cinemate:name", clean);
    return clean;
  }

  function createRoom() {
    socket.emit("room:create", { name: rememberName() }, (snapshot) => setRoom(snapshot));
  }

  function joinRoom() {
    socket.emit("room:join", { roomCode: joinCode, name: rememberName() }, (snapshot) => {
      if (snapshot?.error) alert(snapshot.error);
      else setRoom(snapshot);
    });
  }

  function publishPlayback(patch = {}) {
    const player = videoRef.current;
    if (!room || !player || syncing.current) return;
    socket.emit("playback:update", {
      roomCode: room.code,
      playback: {
        paused: player.paused,
        currentTime: player.currentTime,
        ...patch
      }
    });
  }

  function chooseFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (localUrl) URL.revokeObjectURL(localUrl);
    const nextUrl = URL.createObjectURL(file);
    setLocalUrl(nextUrl);
    socket.emit("playback:update", {
      roomCode: room.code,
      playback: {
        paused: true,
        currentTime: 0,
        title: file.name
      }
    });
  }

  async function shareScreen() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      setScreenStream(stream);
      stream.getVideoTracks()[0]?.addEventListener("ended", () => setScreenStream(null));
    } catch {
      alert("Screen share was cancelled or blocked by the browser.");
    }
  }

  function sendChat(event) {
    event.preventDefault();
    socket.emit("chat:send", { roomCode: room.code, message });
    setMessage("");
  }

  function toggleDevice(key) {
    const next = { ...device, [key]: !device[key] };
    setDevice(next);
    socket.emit("presence:update", { roomCode: room.code, patch: next });
  }

  if (!room) {
    return (
      <main className="landing">
        <section className="intro">
          <div className="brand">
            <Clapperboard size={28} />
            <span>Cinemate</span>
          </div>
          <h1>Movie night, synced like everyone is on the same couch.</h1>
          <p>
            Create a room, share the code, load the same local movie file, and keep playback,
            reactions, chat, voice, and video in one sharp little cinema.
          </p>
        </section>

        <section className="join-panel">
          <label>
            Your name
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Yash" />
          </label>
          <button className="primary" onClick={createRoom}>
            <Sparkles size={18} />
            Host a room
          </button>
          <div className="divider"><span>or join friends</span></div>
          <label>
            Room code
            <input
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
              placeholder="A1B2C3"
            />
          </label>
          <button className="secondary" onClick={joinRoom}>Join room</button>
        </section>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <div className="brand compact">
            <Clapperboard size={22} />
            <span>Cinemate</span>
          </div>
          <p>{room.playback.title}</p>
        </div>
        <div className="room-code">
          <span>{room.code}</span>
          <button title="Copy invite link" onClick={() => navigator.clipboard.writeText(invite)}>
            <Copy size={18} />
          </button>
        </div>
      </header>

      <section className="stage">
        <div className="theater">
          {screenStream ? (
            <video ref={screenRef} autoPlay playsInline className="movie" />
          ) : localUrl ? (
            <video
              ref={videoRef}
              className="movie"
              src={localUrl}
              controls
              onPlay={() => publishPlayback({ paused: false })}
              onPause={() => publishPlayback({ paused: true })}
              onSeeked={() => publishPlayback()}
            />
          ) : (
            <div className="empty">
              <Upload size={42} />
              <h2>Load the movie locally</h2>
              <p>For best quality, everyone should select their own copy of the same file.</p>
            </div>
          )}

          <div className="float-layer">
            {floating.map((item) => (
              <span key={item.id} style={{ left: `${item.x}%` }}>{item.reaction}</span>
            ))}
          </div>
        </div>

        <aside className="side">
          <div className="toolbar">
            <label className="file-button">
              <Upload size={18} />
              Movie
              <input type="file" accept="video/*,.mkv" onChange={chooseFile} />
            </label>
            <button onClick={shareScreen} title="Share screen with audio">
              <MonitorUp size={18} />
            </button>
            <button onClick={() => toggleDevice("audio")} title="Toggle mic">
              {device.audio ? <Mic size={18} /> : <MicOff size={18} />}
            </button>
            <button onClick={() => toggleDevice("video")} title="Toggle camera">
              {device.video ? <Camera size={18} /> : <CameraOff size={18} />}
            </button>
          </div>

          <div className="sync-card">
            <h3>Sync Control</h3>
            <div className="sync-buttons">
              <button onClick={() => videoRef.current?.play()}>
                <Play size={18} />
              </button>
              <button onClick={() => videoRef.current?.pause()}>
                <Pause size={18} />
              </button>
              <button onClick={() => publishPlayback()}>Resync</button>
            </div>
            <p>{isHost ? "You are hosting this room." : "Playback follows the room host."}</p>
          </div>

          <div className="people">
            <h3><Users size={18} /> People</h3>
            {people.map((person) => (
              <div className="person" key={person.id}>
                <span>{person.avatar}</span>
                <strong>{person.name}</strong>
                {person.host && <em>host</em>}
                {person.audio ? <Mic size={14} /> : <MicOff size={14} />}
                {person.video ? <Camera size={14} /> : <CameraOff size={14} />}
              </div>
            ))}
          </div>

          <div className="reactions">
            {reactions.map((reaction) => (
              <button
                key={reaction}
                onClick={() => socket.emit("reaction:send", { roomCode: room.code, reaction })}
              >
                {reaction}
              </button>
            ))}
          </div>
        </aside>
      </section>

      <section className="chat">
        <div className="chat-title">
          <MessageCircle size={18} />
          <span>Room chat</span>
          <a href={invite}><Link size={16} /> Invite</a>
        </div>
        <div className="messages">
          {messages.map((item) => (
            <p key={item.id}>
              <strong>{item.name}</strong>
              {item.message}
            </p>
          ))}
        </div>
        <form onSubmit={sendChat}>
          <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Say something..." />
          <button>
            <Send size={18} />
          </button>
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
