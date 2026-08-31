import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { upload } from "@vercel/blob/client";
import { io } from "socket.io-client";
import {
  Camera,
  CameraOff,
  Clapperboard,
  Copy,
  DoorClosed,
  Expand,
  FileVideo,
  Link,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  MonitorUp,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Send,
  Sparkles,
  Subtitles,
  Upload,
  Users,
  Volume2,
  Wand2
} from "lucide-react";
import "./styles.css";

const isLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const serverUrl = import.meta.env.VITE_SIGNALING_URL || (
  isLocalhost ? "http://localhost:3001" : window.location.origin
);
const socket = io(serverUrl, { autoConnect: true });
const reactions = ["🔥", "😂", "😱", "😭", "👏", "🍿", "🤯", "❤️"];
const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function syncTime(playback) {
  if (playback.paused) return playback.currentTime;
  return playback.currentTime + (Date.now() - playback.updatedAt) / 1000;
}

function VideoTile({ stream, name, muted = false }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  return (
    <div className="video-tile">
      <video ref={ref} autoPlay playsInline webkit-playsinline="true" muted={muted} />
      <span>{name}</span>
    </div>
  );
}

function App() {
  const [name, setName] = useState(localStorage.getItem("cinemate:name") || "");
  const [joinCode, setJoinCode] = useState("");
  const [room, setRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState("");
  const [localUrl, setLocalUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [movieSource, setMovieSource] = useState(null);
  const [remoteMovieStream, setRemoteMovieStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [localMediaStream, setLocalMediaStream] = useState(null);
  const [remoteMedia, setRemoteMedia] = useState({});
  const [floating, setFloating] = useState([]);
  const [device, setDevice] = useState({ audio: false, video: false });
  const [theaterMode, setTheaterMode] = useState(false);
  const [connectionState, setConnectionState] = useState(socket.connected ? "connected" : "connecting");
  const [needsPlaybackGesture, setNeedsPlaybackGesture] = useState(false);
  const videoRef = useRef(null);
  const remoteMovieRef = useRef(null);
  const theaterRef = useRef(null);
  const syncing = useRef(false);
  const peerConnections = useRef(new Map());
  const pendingIce = useRef(new Map());
  const movieStreamRef = useRef(null);
  const localMediaRef = useRef(null);
  const roomRef = useRef(null);

  const isHost = room?.hostId === socket.id;
  const invite = room ? `${window.location.origin}?room=${room.code}` : "";
  const movieUrl = room?.playback?.mediaUrl || localUrl;
  const people = useMemo(() => room?.people || [], [room]);
  const remoteMediaList = Object.entries(remoteMedia).map(([peerId, stream]) => ({
    peerId,
    stream,
    name: people.find((person) => person.id === peerId)?.name || "Friend"
  }));

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get("room");
    if (roomParam) setJoinCode(roomParam.toUpperCase());
  }, []);

  useEffect(() => {
    socket.on("room:update", (snapshot) => {
      setRoom(snapshot);
      reconcilePeers(snapshot);
    });
    socket.on("connect", () => setConnectionState("connected"));
    socket.on("disconnect", () => setConnectionState("disconnected"));
    socket.on("connect_error", () => setConnectionState("disconnected"));
    socket.on("room:ended", () => {
      closeAllPeers();
      setRoom(null);
      setLocalUrl("");
      setRemoteMovieStream(null);
      setScreenStream(null);
      alert("The room has ended and its uploaded movie was scheduled for cleanup.");
    });
    socket.on("chat:new", (next) => setMessages((current) => [...current, next]));
    socket.on("reaction:new", (next) => {
      setFloating((current) => [...current, next]);
      window.setTimeout(() => {
        setFloating((current) => current.filter((item) => item.id !== next.id));
      }, 2400);
    });
    socket.on("playback:sync", (playback) => {
      applyPlayback(playback);
    });
    socket.on("movie:ready", (playback) => {
      setMovieSource(playback.source || "upload");
      setScreenStream(null);
      setRemoteMovieStream(null);
    });
    socket.on("webrtc:offer", handleOffer);
    socket.on("webrtc:answer", handleAnswer);
    socket.on("webrtc:ice", handleIce);
    return () => {
      socket.off("room:update");
      socket.off("connect");
      socket.off("disconnect");
      socket.off("connect_error");
      socket.off("room:ended");
      socket.off("chat:new");
      socket.off("reaction:new");
      socket.off("playback:sync");
      socket.off("movie:ready");
      socket.off("webrtc:offer");
      socket.off("webrtc:answer");
      socket.off("webrtc:ice");
      closeAllPeers();
    };
  }, []);

  useEffect(() => {
    if (!remoteMovieRef.current) return;
    remoteMovieRef.current.srcObject = remoteMovieStream;
    if (remoteMovieStream) attemptPlay(remoteMovieRef.current);
  }, [remoteMovieStream]);

  useEffect(() => {
    if (!movieUrl || !room?.playback) return;
    window.setTimeout(() => applyPlayback(room.playback), 150);
  }, [movieUrl, room?.playback?.mediaUrl]);

  function rememberName() {
    const clean = name.trim() || "Movie Buddy";
    localStorage.setItem("cinemate:name", clean);
    return clean;
  }

  function createRoom() {
    socket.emit("room:create", { name: rememberName() }, (snapshot) => {
      setRoom(snapshot);
      reconcilePeers(snapshot);
    });
  }

  function joinRoom() {
    socket.emit("room:join", { roomCode: joinCode, name: rememberName() }, (snapshot) => {
      if (snapshot?.error) alert(snapshot.error);
      else {
        setRoom(snapshot);
        reconcilePeers(snapshot);
      }
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

  function attemptPlay(player) {
    if (!player) return;
    player.play()
      .then(() => setNeedsPlaybackGesture(false))
      .catch(() => setNeedsPlaybackGesture(true));
  }

  function applyPlayback(playback) {
    const player = videoRef.current;
    if (!player || !playback) return;
    syncing.current = true;
    const target = syncTime(playback);
    if (Number.isFinite(target) && Math.abs(player.currentTime - target) > 0.45) {
      player.currentTime = Math.max(0, target);
    }
    if (playback.paused) {
      player.pause();
      setNeedsPlaybackGesture(false);
    } else {
      attemptPlay(player);
    }
    window.setTimeout(() => {
      syncing.current = false;
    }, 250);
  }

  function emitSignal(event, peerId, channel, payload) {
    const activeRoom = roomRef.current;
    if (!activeRoom) return;
    socket.emit(event, {
      roomCode: activeRoom.code,
      to: peerId,
      channel,
      ...payload
    });
  }

  function peerKey(channel, peerId) {
    return `${channel}:${peerId}`;
  }

  function closePeer(channel, peerId) {
    const key = peerKey(channel, peerId);
    peerConnections.current.get(key)?.close();
    peerConnections.current.delete(key);
    pendingIce.current.delete(key);
  }

  function closeAllPeers() {
    for (const pc of peerConnections.current.values()) pc.close();
    peerConnections.current.clear();
    pendingIce.current.clear();
  }

  function createPeer(channel, peerId) {
    const key = peerKey(channel, peerId);
    const existing = peerConnections.current.get(key);
    if (existing && existing.connectionState !== "closed") return existing;

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections.current.set(key, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) emitSignal("webrtc:ice", peerId, channel, { candidate: event.candidate });
    };

    pc.onconnectionstatechange = () => {
      if (!["failed", "disconnected", "closed"].includes(pc.connectionState)) return;
      if (channel === "movie") setRemoteMovieStream(null);
      if (channel === "call") {
        setRemoteMedia((current) => {
          const next = { ...current };
          delete next[peerId];
          return next;
        });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      if (channel === "movie") setRemoteMovieStream(stream);
      if (channel === "call") setRemoteMedia((current) => ({ ...current, [peerId]: stream }));
    };

    if (channel === "call" && localMediaRef.current) {
      localMediaRef.current.getTracks().forEach((track) => pc.addTrack(track, localMediaRef.current));
    }

    if (channel === "movie" && roomRef.current?.hostId === socket.id && movieStreamRef.current) {
      movieStreamRef.current.getTracks().forEach((track) => pc.addTrack(track, movieStreamRef.current));
    }

    return pc;
  }

  async function makeOffer(channel, peerId) {
    const pc = createPeer(channel, peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    emitSignal("webrtc:offer", peerId, channel, { description: pc.localDescription });
  }

  async function handleOffer({ from, channel, description }) {
    const pc = createPeer(channel, from);
    await pc.setRemoteDescription(description);
    await flushIce(channel, from);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    emitSignal("webrtc:answer", from, channel, { description: pc.localDescription });
  }

  async function handleAnswer({ from, channel, description }) {
    const pc = peerConnections.current.get(peerKey(channel, from));
    if (!pc) return;
    await pc.setRemoteDescription(description);
    await flushIce(channel, from);
  }

  async function handleIce({ from, channel, candidate }) {
    const key = peerKey(channel, from);
    const pc = peerConnections.current.get(key);
    if (!pc?.remoteDescription) {
      pendingIce.current.set(key, [...(pendingIce.current.get(key) || []), candidate]);
      return;
    }
    await pc.addIceCandidate(candidate).catch(() => {});
  }

  async function flushIce(channel, peerId) {
    const key = peerKey(channel, peerId);
    const pc = peerConnections.current.get(key);
    const queued = pendingIce.current.get(key) || [];
    pendingIce.current.delete(key);
    for (const candidate of queued) await pc.addIceCandidate(candidate).catch(() => {});
  }

  function reconcilePeers(snapshot) {
    if (!snapshot) return;
    const others = snapshot.people.filter((person) => person.id !== socket.id);
    const liveIds = new Set(others.map((person) => person.id));

    for (const key of peerConnections.current.keys()) {
      const [channel, peerId] = key.split(":");
      if (!liveIds.has(peerId)) closePeer(channel, peerId);
    }

    for (const person of others) {
      if (localMediaRef.current && socket.id < person.id) makeOffer("call", person.id).catch(() => {});
      if (snapshot.hostId === socket.id && movieStreamRef.current) {
        makeOffer("movie", person.id).catch(() => {});
      }
    }
  }

  function restartMovieBroadcast() {
    const activeRoom = roomRef.current;
    if (!activeRoom) return;
    for (const key of [...peerConnections.current.keys()]) {
      if (key.startsWith("movie:")) closePeer("movie", key.slice("movie:".length));
    }
    activeRoom.people
      .filter((person) => person.id !== socket.id)
      .forEach((person) => makeOffer("movie", person.id).catch(() => {}));
  }

  function restartCallLayer() {
    const activeRoom = roomRef.current;
    if (!activeRoom) return;
    for (const key of [...peerConnections.current.keys()]) {
      if (key.startsWith("call:")) closePeer("call", key.slice("call:".length));
    }
    activeRoom.people
      .filter((person) => person.id !== socket.id)
      .forEach((person) => makeOffer("call", person.id).catch(() => {}));
  }

  async function startLocalMedia(nextDevice = device) {
    if (!nextDevice.audio && !nextDevice.video) {
      localMediaRef.current?.getTracks().forEach((track) => track.stop());
      setLocalMediaStream(null);
      localMediaRef.current = null;
      restartCallLayer();
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: nextDevice.audio
        ? {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
            sampleRate: 48000
          }
        : false,
      video: nextDevice.video
        ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
        : false
    });
    localMediaRef.current?.getTracks().forEach((track) => track.stop());
    localMediaRef.current = stream;
    setLocalMediaStream(stream);
    restartCallLayer();
  }

  async function chooseFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (localUrl) URL.revokeObjectURL(localUrl);
    const nextUrl = URL.createObjectURL(file);
    setLocalUrl(nextUrl);
    setUploading(true);
    setUploadProgress(0);
    setMovieSource("upload");
    setRemoteMovieStream(null);
    setScreenStream(null);
    try {
      const playback = isLocalhost
        ? await uploadToLocalServer(file)
        : await uploadToVercelBlob(file);
      setRoom((current) => current ? { ...current, playback } : current);
      window.setTimeout(() => videoRef.current?.load(), 50);
      window.setTimeout(() => applyPlayback(playback), 250);
    } catch {
      alert("Movie upload failed. Try a smaller file or use screen share.");
    } finally {
      setUploading(false);
      setUploadProgress(0);
      event.target.value = "";
    }
  }

  async function uploadToLocalServer(file) {
    const body = new FormData();
    body.append("movie", file);
    const response = await fetch(`${serverUrl}/api/rooms/${room.code}/movie`, {
      method: "POST",
      body
    });
    if (!response.ok) throw new Error("Upload failed");
    const playback = await response.json();
    return playback;
  }

  async function uploadToVercelBlob(file) {
    const safeName = file.name.replace(/[^\w.\-() ]/g, "_");
    const blob = await upload(`rooms/${room.code}/${Date.now()}-${safeName}`, file, {
      access: "public",
      handleUploadUrl: "/api/blob/upload",
      multipart: true,
      clientPayload: JSON.stringify({
        roomCode: room.code,
        title: file.name
      }),
      onUploadProgress: (progressEvent) => {
        setUploadProgress(Math.round(progressEvent.percentage || 0));
      }
    });

    const playback = {
      paused: true,
      currentTime: 0,
      updatedAt: Date.now(),
      title: file.name,
      mediaUrl: blob.url,
      pathname: blob.pathname,
      source: "blob"
    };

    socket.emit("playback:update", {
      roomCode: room.code,
      playback
    });

    return playback;
  }

  async function shareScreen() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      setScreenStream(stream);
      setMovieSource("screen");
      movieStreamRef.current = stream;
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        setScreenStream(null);
        movieStreamRef.current = null;
        restartMovieBroadcast();
      });
      restartMovieBroadcast();
    } catch {
      alert("Screen share was cancelled or blocked by the browser.");
    }
  }

  function sendChat(event) {
    event.preventDefault();
    socket.emit("chat:send", { roomCode: room.code, message });
    setMessage("");
  }

  async function toggleDevice(key) {
    const next = { ...device, [key]: !device[key] };
    try {
      setDevice(next);
      await startLocalMedia(next);
      socket.emit("presence:update", { roomCode: room.code, patch: next });
    } catch {
      alert(`${key === "audio" ? "Microphone" : "Camera"} permission was blocked.`);
      setDevice(device);
    }
  }

  async function toggleFullscreen() {
    if (!document.fullscreenElement) {
      await theaterRef.current?.requestFullscreen();
      setTheaterMode(true);
    } else {
      await document.exitFullscreen();
      setTheaterMode(false);
    }
  }

  function jump(seconds) {
    const player = videoRef.current;
    if (!player) return;
    player.currentTime = Math.max(0, player.currentTime + seconds);
    publishPlayback();
  }

  function unlockPlayback() {
    attemptPlay(videoRef.current || remoteMovieRef.current);
  }

  function endRoom() {
    if (!room || !isHost) return;
    const confirmed = window.confirm("End this room for everyone and delete the uploaded movie?");
    if (!confirmed) return;
    socket.emit("room:end", { roomCode: room.code });
  }

  if (!room) {
    return (
      <main className="landing">
        <section className="intro">
          <div className="brand">
            <Clapperboard size={28} />
            <span>Cinemate</span>
          </div>
          <h1>Movie night, streamed and synced from one host.</h1>
          <p>
            Host a room, load a movie, broadcast it live, keep everyone on the same timestamp,
            and throw chat, reactions, voice, and camera into one wild little cinema.
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
    <main className={`app ${theaterMode ? "cinema-focus" : ""}`}>
      <header className="topbar">
        <div>
          <div className="brand compact">
            <Clapperboard size={22} />
            <span>Cinemate</span>
          </div>
          <p>{room.playback.title}</p>
          <span className={`connection ${connectionState}`}>{connectionState}</span>
        </div>
        <div className="room-code">
          <span>{room.code}</span>
          <button title="Copy invite link" onClick={() => navigator.clipboard.writeText(invite)}>
            <Copy size={18} />
          </button>
        </div>
      </header>

      <section className="stage">
        <div className="theater" ref={theaterRef}>
          {isHost && screenStream ? (
            <video
              autoPlay
              muted
              className="movie"
              ref={(node) => {
                if (node) node.srcObject = screenStream;
              }}
              playsInline
              webkit-playsinline="true"
            />
          ) : movieUrl ? (
            <video
              ref={videoRef}
              className="movie"
              src={movieUrl}
              controls
              playsInline
              webkit-playsinline="true"
              preload="metadata"
              crossOrigin="anonymous"
              controlsList="nodownload noplaybackrate"
              disablePictureInPicture
              onPlay={() => publishPlayback({ paused: false })}
              onPause={() => publishPlayback({ paused: true })}
              onSeeked={() => publishPlayback()}
            />
          ) : remoteMovieStream ? (
            <video
              ref={remoteMovieRef}
              className="movie"
              autoPlay
              playsInline
              webkit-playsinline="true"
              controls
            />
          ) : (
            <div className="empty">
              <Radio size={46} />
              <h2>{isHost ? "Choose a movie or share screen" : "Waiting for the host stream"}</h2>
              <p>
                {isHost
                  ? "Once selected, the movie is broadcast live to everyone in the room."
                  : "Keep this tab open. The host broadcast will appear here automatically."}
              </p>
            </div>
          )}

          <div className="hud">
            <button onClick={() => jump(-10)} title="Back 10 seconds">
              <RotateCcw size={18} />
            </button>
            <button onClick={toggleFullscreen} title="Fullscreen">
              <Expand size={18} />
            </button>
            <button onClick={() => socket.emit("reaction:send", { roomCode: room.code, reaction: "🍿" })}>
              <Wand2 size={18} />
            </button>
          </div>

          <div className="float-layer">
            {floating.map((item) => (
              <span key={item.id} style={{ left: `${item.x}%` }}>{item.reaction}</span>
            ))}
          </div>

          {needsPlaybackGesture && (
            <div className="playback-unlock">
              <button onClick={unlockPlayback}>
                <Play size={18} />
                Start playback
              </button>
            </div>
          )}
        </div>

        <aside className="side">
          <div className={`toolbar ${isHost ? "" : "viewer-tools"}`}>
            {isHost && (
              <label className={`file-button ${localUrl ? "loaded" : ""}`}>
                {localUrl ? <FileVideo size={18} /> : <Upload size={18} />}
                {uploading ? `Uploading ${uploadProgress}%` : localUrl ? "Change Movie" : "Upload Movie"}
                <input type="file" accept="video/*,.mkv" onChange={chooseFile} />
              </label>
            )}
            <button className={movieSource === "screen" ? "active" : ""} onClick={shareScreen} title="Share screen with audio">
              <MonitorUp size={18} />
            </button>
            <button className={device.audio ? "active" : ""} onClick={() => toggleDevice("audio")} title="Toggle mic">
              {device.audio ? <Mic size={18} /> : <MicOff size={18} />}
            </button>
            <button className={device.video ? "active" : ""} onClick={() => toggleDevice("video")} title="Toggle camera">
              {device.video ? <Camera size={18} /> : <CameraOff size={18} />}
            </button>
            <button onClick={toggleFullscreen} title="Fullscreen">
              <Maximize2 size={18} />
            </button>
            {isHost && (
              <button className="danger" onClick={endRoom} title="End room and delete movie">
                <DoorClosed size={18} />
              </button>
            )}
          </div>

          <div className="sync-card">
            <h3><Volume2 size={18} /> Watch Control</h3>
            <div className="sync-buttons">
              <button onClick={() => videoRef.current?.play()} disabled={!isHost}>
                <Play size={18} />
              </button>
              <button onClick={() => videoRef.current?.pause()} disabled={!isHost}>
                <Pause size={18} />
              </button>
              <button onClick={() => publishPlayback()} disabled={!isHost}>Resync</button>
            </div>
            <p>{isHost ? "You are broadcasting the room stream." : "You are watching the host broadcast."}</p>
          </div>

          <div className="watch-stats">
            <div><strong>{people.length}</strong><span>inside</span></div>
            <div><strong>{movieUrl || remoteMovieStream || screenStream ? "Live" : "Idle"}</strong><span>stream</span></div>
            <div><strong>{movieSource === "screen" ? "Screen" : "Movie"}</strong><span>source</span></div>
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

          <div className="call-grid">
            {localMediaStream && <VideoTile stream={localMediaStream} name="You" muted />}
            {remoteMediaList.map((item) => (
              <VideoTile key={item.peerId} stream={item.stream} name={item.name} />
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

          <button className="subtitle-button">
            <Subtitles size={18} />
            Subtitles soon
          </button>
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
