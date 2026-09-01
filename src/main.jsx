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
  LogOut,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  MonitorUp,
  Pause,
  Play,
  Radio,
  RotateCcw,
  RotateCw,
  Send,
  Sparkles,
  Subtitles,
  Upload,
  RefreshCw,
  X,
  UserX,
  Users,
  Volume2,
} from "lucide-react";
import "./styles.css";

const isLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const serverUrl = import.meta.env.VITE_SIGNALING_URL || (
  isLocalhost ? "http://localhost:3001" : window.location.origin
);
const socket = io(serverUrl, { autoConnect: true, reconnection: true, reconnectionAttempts: Infinity });
const clientId = localStorage.getItem("cinemate:clientId") || crypto.randomUUID();
localStorage.setItem("cinemate:clientId", clientId);
const reactions = [
  { emoji: "😂", key: "L", label: "Laugh" },
  { emoji: "❤️", key: "H", label: "Love" },
  { emoji: "😘", key: "K", label: "Kiss" },
  { emoji: "🔥", key: "F", label: "Fire" },
  { emoji: "😱", key: "S", label: "Shock" },
  { emoji: "😭", key: "C", label: "Cry" },
  { emoji: "🤯", key: "M", label: "Mind" },
  { emoji: "👀", key: "E", label: "Eyes" }
];
const turnServer = import.meta.env.VITE_TURN_URL
  ? {
      urls: import.meta.env.VITE_TURN_URL,
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL
    }
  : null;
const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    ...(turnServer ? [turnServer] : [])
  ],
  iceCandidatePoolSize: 4
};

function syncTime(playback) {
  if (playback.paused) return playback.currentTime;
  return playback.currentTime + (Date.now() - playback.updatedAt) / 1000;
}

function VideoTile({ stream, name, muted = false, onPlaybackBlocked }) {
  const ref = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream;
      ref.current.play().catch(() => onPlaybackBlocked?.());
    }
    if (audioRef.current) {
      audioRef.current.srcObject = stream;
      audioRef.current.play().catch(() => onPlaybackBlocked?.());
    }
  }, [stream, onPlaybackBlocked]);

  return (
    <div className="video-tile">
      <video
        ref={ref}
        autoPlay
        playsInline
        webkit-playsinline="true"
        muted
        onLoadedMetadata={() => ref.current?.play().catch(() => onPlaybackBlocked?.())}
      />
      {!muted && (
        <audio
          ref={audioRef}
          autoPlay
          onLoadedMetadata={() => audioRef.current?.play().catch(() => onPlaybackBlocked?.())}
        />
      )}
      <span>{name}</span>
    </div>
  );
}

function CallPlaceholder({ person }) {
  return (
    <div className="video-tile placeholder">
      <CameraOff size={22} />
      <span>{person.name}</span>
    </div>
  );
}

function App() {
  const [name, setName] = useState(localStorage.getItem("cinemate:name") || "");
  const [joinCode, setJoinCode] = useState("");
  const [linkRoomCode, setLinkRoomCode] = useState("");
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
  const [playerWarning, setPlayerWarning] = useState("");
  const [fullscreenChatHidden, setFullscreenChatHidden] = useState(false);
  const [movieLoadWarning, setMovieLoadWarning] = useState(false);
  const videoRef = useRef(null);
  const remoteMovieRef = useRef(null);
  const theaterRef = useRef(null);
  const chatInputRef = useRef(null);
  const syncing = useRef(false);
  const peerConnections = useRef(new Map());
  const pendingIce = useRef(new Map());
  const remoteStreams = useRef(new Map());
  const audioContextRef = useRef(null);
  const movieStreamRef = useRef(null);
  const localMediaRef = useRef(null);
  const roomRef = useRef(null);
  const deviceRef = useRef(device);
  const autoJoinAttempted = useRef(false);

  const isHost = room?.hostId === socket.id;
  const invite = room ? `${window.location.origin}?room=${room.code}` : "";
  const movieUrl = room?.playback?.mediaUrl || localUrl;
  const people = useMemo(() => room?.people || [], [room]);
  const recentMessages = messages.slice(-3);
  const remoteMediaList = Object.entries(remoteMedia).map(([peerId, stream]) => ({
    peerId,
    stream,
    name: people.find((person) => person.id === peerId)?.name || "Friend"
  }));
  const remoteMediaIds = new Set(remoteMediaList.map((item) => item.peerId));
  const missingMediaPeople = people.filter((person) => person.id !== socket.id && !remoteMediaIds.has(person.id));

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  useEffect(() => {
    deviceRef.current = device;
  }, [device]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get("room");
    if (roomParam) {
      const normalized = roomParam.toUpperCase();
      setJoinCode(normalized);
      setLinkRoomCode(normalized);
    }
  }, []);

  useEffect(() => {
    if (!linkRoomCode || room || autoJoinAttempted.current) return;
    autoJoinAttempted.current = true;
    socket.emit("room:join", { roomCode: linkRoomCode, name: rememberName(), clientId }, (snapshot) => {
      if (snapshot?.error) {
        autoJoinAttempted.current = false;
        alert(snapshot.error);
      } else {
        setRoom(snapshot);
        reconcilePeers(snapshot);
      }
    });
  }, [linkRoomCode, room]);

  useEffect(() => {
    socket.on("room:update", (snapshot) => {
      setRoom(snapshot);
      reconcilePeers(snapshot);
    });
    socket.on("connect", () => {
      setConnectionState("connected");
      const activeRoom = roomRef.current;
      if (!activeRoom) return;
      socket.emit("room:join", { roomCode: activeRoom.code, name: rememberName(), clientId }, (snapshot) => {
        if (snapshot?.error) return;
        setRoom(snapshot);
        reconcilePeers(snapshot);
        const activeDevice = deviceRef.current;
        if (activeDevice.audio || activeDevice.video) {
          socket.emit("presence:update", { roomCode: snapshot.code, patch: activeDevice });
        }
      });
    });
    socket.on("disconnect", () => setConnectionState("disconnected"));
    socket.on("connect_error", () => setConnectionState("disconnected"));
    socket.on("room:ended", () => {
      resetLocalRoom();
      alert("The room has ended and its uploaded movie was scheduled for cleanup.");
    });
    socket.on("room:left", ({ reason }) => {
      resetLocalRoom();
      if (reason === "kicked") alert("The host removed you from the room.");
    });
    socket.on("presence:joined", ({ name }) => {
      playPresenceTone("join");
      addSystemMessage(`${name || "Someone"} joined the room`);
    });
    socket.on("presence:left", ({ name, reason }) => {
      playPresenceTone("leave");
      addSystemMessage(`${name || "Someone"} ${reason === "kicked" ? "was removed" : "left"} the room`);
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
      socket.off("room:left");
      socket.off("presence:joined");
      socket.off("presence:left");
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

  useEffect(() => {
    function handleFullscreenChange() {
      setTheaterMode(document.fullscreenElement === theaterRef.current);
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    function handleHotkeys(event) {
      const tagName = document.activeElement?.tagName?.toLowerCase();
      const isTyping = ["input", "textarea", "select"].includes(tagName) || document.activeElement?.isContentEditable;
      if (isTyping || event.ctrlKey || event.metaKey || event.altKey || !roomRef.current) return;
      if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        setFullscreenChatHidden((current) => !current);
        return;
      }
      const match = reactions.find((reaction) => reaction.key.toLowerCase() === event.key.toLowerCase());
      if (!match) return;
      event.preventDefault();
      event.stopPropagation();
      sendReaction(match.emoji);
    }

    window.addEventListener("keydown", handleHotkeys, true);
    return () => window.removeEventListener("keydown", handleHotkeys, true);
  }, []);

  function rememberName() {
    const clean = name.trim() || "Movie Buddy";
    localStorage.setItem("cinemate:name", clean);
    return clean;
  }

  function resetLocalRoom() {
    closeAllPeers();
    localMediaRef.current?.getTracks().forEach((track) => track.stop());
    movieStreamRef.current?.getTracks().forEach((track) => track.stop());
    setRoom(null);
    setLocalUrl("");
    setRemoteMovieStream(null);
    setScreenStream(null);
    setLocalMediaStream(null);
    setRemoteMedia({});
    setDevice({ audio: false, video: false });
    setNeedsPlaybackGesture(false);
    setPlayerWarning("");
  }

  function addSystemMessage(messageText) {
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        name: "Cinemate",
        message: messageText,
        at: new Date().toISOString()
      }
    ]);
  }

  function sendReaction(reaction) {
    const activeRoom = roomRef.current;
    if (!activeRoom) return;
    socket.emit("reaction:send", { roomCode: activeRoom.code, reaction });
  }

  function playPresenceTone(type) {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const context = audioContextRef.current || new AudioContext();
      audioContextRef.current = context;
      context.resume?.().catch(() => {});
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = type === "join" ? 660 : 330;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.2);
    } catch {
      // Presence sounds are nice-to-have and browser gesture policies may block them.
    }
  }

  function createRoom() {
    socket.emit("room:create", { name: rememberName(), clientId }, (snapshot) => {
      setRoom(snapshot);
      reconcilePeers(snapshot);
    });
  }

  function joinRoom() {
    socket.emit("room:join", { roomCode: joinCode, name: rememberName(), clientId }, (snapshot) => {
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

  function canBrowserPlay(file) {
    const probe = document.createElement("video");
    const typeOk = file.type && probe.canPlayType(file.type);
    if (typeOk) return true;
    return /\.(mp4|m4v|webm|ogv|ogg)$/i.test(file.name);
  }

  function handleMovieMetadata() {
    const player = videoRef.current;
    if (!player) return;
    if (player.videoWidth === 0 && player.readyState > 0) {
      setMovieLoadWarning(true);
      return;
    }
    setMovieLoadWarning(false);
    setPlayerWarning("");
    applyPlayback(roomRef.current?.playback);
  }

  function handleMovieError() {
    const player = videoRef.current;
    if (player?.currentTime > 1 || player?.readyState >= 2) {
      setMovieLoadWarning(false);
      setPlayerWarning("");
      return;
    }
    setMovieLoadWarning(true);
  }

  function showMovieWarning() {
    setPlayerWarning("This browser could not load the movie video. Try MP4 H.264 + AAC, or use screen share for this file.");
    setMovieLoadWarning(false);
  }

  function retryMovieLoad() {
    const playback = roomRef.current?.playback;
    const player = videoRef.current;
    if (!player || !playback) return;
    setMovieLoadWarning(false);
    setPlayerWarning("");
    player.load();
    window.setTimeout(() => applyPlayback(playback), 250);
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
    remoteStreams.current.delete(key);
  }

  function closeAllPeers() {
    for (const pc of peerConnections.current.values()) pc.close();
    peerConnections.current.clear();
    pendingIce.current.clear();
    remoteStreams.current.clear();
  }

  function ensureCallTransceivers(pc) {
    const hasAudio = pc.getTransceivers().some((transceiver) => (
      transceiver.sender?.track?.kind === "audio" || transceiver.receiver?.track?.kind === "audio"
    ));
    const hasVideo = pc.getTransceivers().some((transceiver) => (
      transceiver.sender?.track?.kind === "video" || transceiver.receiver?.track?.kind === "video"
    ));
    if (!hasAudio) pc.addTransceiver("audio", { direction: "sendrecv" });
    if (!hasVideo) pc.addTransceiver("video", { direction: "sendrecv" });
  }

  async function syncCallTracks(pc) {
    ensureCallTransceivers(pc);
    const stream = localMediaRef.current;
    const audioTrack = stream?.getAudioTracks()[0] || null;
    const videoTrack = stream?.getVideoTracks()[0] || null;
    const audioSender = pc.getTransceivers().find((transceiver) => (
      transceiver.sender?.track?.kind === "audio" || transceiver.receiver?.track?.kind === "audio"
    ))?.sender;
    const videoSender = pc.getTransceivers().find((transceiver) => (
      transceiver.sender?.track?.kind === "video" || transceiver.receiver?.track?.kind === "video"
    ))?.sender;

    await audioSender?.replaceTrack(audioTrack);
    await videoSender?.replaceTrack(videoTrack);
  }

  function createPeer(channel, peerId) {
    const key = peerKey(channel, peerId);
    const existing = peerConnections.current.get(key);
    if (existing && existing.connectionState !== "closed") return existing;

    const pc = new RTCPeerConnection(rtcConfig);
    pc._makingOffer = false;
    pc._ignoreOffer = false;
    pc._polite = socket.id > peerId;
    peerConnections.current.set(key, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) emitSignal("webrtc:ice", peerId, channel, { candidate: event.candidate });
    };

    pc.onconnectionstatechange = () => {
      if (!["failed", "closed"].includes(pc.connectionState)) return;
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
      let [stream] = event.streams;
      if (!stream) {
        stream = remoteStreams.current.get(key) || new MediaStream();
        remoteStreams.current.set(key, stream);
        if (!stream.getTracks().some((track) => track.id === event.track.id)) {
          stream.addTrack(event.track);
        }
      }
      if (channel === "movie") setRemoteMovieStream(stream);
      if (channel === "call") setRemoteMedia((current) => ({ ...current, [peerId]: stream }));
    };

    if (channel === "movie" && roomRef.current?.hostId === socket.id && movieStreamRef.current) {
      movieStreamRef.current.getTracks().forEach((track) => pc.addTrack(track, movieStreamRef.current));
    }

    return pc;
  }

  async function makeOffer(channel, peerId) {
    const pc = createPeer(channel, peerId);
    if (channel === "call") await syncCallTracks(pc);
    if (pc.signalingState !== "stable" || pc._makingOffer) return;
    pc._makingOffer = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      emitSignal("webrtc:offer", peerId, channel, { description: pc.localDescription });
    } finally {
      pc._makingOffer = false;
    }
  }

  async function handleOffer({ from, channel, description }) {
    const pc = createPeer(channel, from);
    const offerCollision = description.type === "offer" && (pc._makingOffer || pc.signalingState !== "stable");
    pc._ignoreOffer = !pc._polite && offerCollision;
    if (pc._ignoreOffer) return;

    if (offerCollision) {
      await pc.setLocalDescription({ type: "rollback" });
    }

    await pc.setRemoteDescription(description);
    if (channel === "call") await syncCallTracks(pc);
    await flushIce(channel, from);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    emitSignal("webrtc:answer", from, channel, { description: pc.localDescription });
  }

  async function handleAnswer({ from, channel, description }) {
    const pc = peerConnections.current.get(peerKey(channel, from));
    if (!pc) return;
    if (pc.signalingState === "stable") return;
    await pc.setRemoteDescription(description);
    await flushIce(channel, from);
  }

  async function handleIce({ from, channel, candidate }) {
    const key = peerKey(channel, from);
    const pc = peerConnections.current.get(key);
    if (pc?._ignoreOffer) return;
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
      if (localMediaRef.current && !peerConnections.current.has(peerKey("call", person.id))) {
        makeOffer("call", person.id).catch(() => {});
      }
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
    if (!canBrowserPlay(file)) {
      const confirmed = window.confirm(
        "This file may upload, but browsers often show a blank video for MKV/HEVC/x265 files. MP4 H.264 + AAC is the safest format. Upload anyway?"
      );
      if (!confirmed) {
        event.target.value = "";
        return;
      }
    }
    if (localUrl) URL.revokeObjectURL(localUrl);
    const nextUrl = URL.createObjectURL(file);
    setLocalUrl(nextUrl);
    setPlayerWarning("");
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
    if (!message.trim()) return;
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
    document.querySelectorAll("video, audio").forEach((player) => {
      player.play().catch(() => {});
    });
    attemptPlay(videoRef.current || remoteMovieRef.current);
  }

  function endRoom() {
    if (!room || !isHost) return;
    const confirmed = window.confirm("End this room for everyone and delete the uploaded movie?");
    if (!confirmed) return;
    socket.emit("room:end", { roomCode: room.code });
  }

  function leaveRoom() {
    if (!room) return;
    socket.emit("room:leave", { roomCode: room.code });
    resetLocalRoom();
  }

  function kickPerson(person) {
    if (!room || !isHost || person.host) return;
    const confirmed = window.confirm(`Remove ${person.name} from this room?`);
    if (!confirmed) return;
    socket.emit("room:kick", { roomCode: room.code, personId: person.id });
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
              key={movieUrl}
              ref={videoRef}
              className="movie"
              src={movieUrl}
              controls={!theaterMode}
              playsInline
              webkit-playsinline="true"
              preload="metadata"
              controlsList="nodownload noplaybackrate"
              disablePictureInPicture
              onLoadedMetadata={handleMovieMetadata}
              onCanPlay={handleMovieMetadata}
              onError={handleMovieError}
              onPlaying={() => {
                setMovieLoadWarning(false);
                setPlayerWarning("");
              }}
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
            <button onClick={() => jump(10)} title="Forward 10 seconds">
              <RotateCw size={18} />
            </button>
          </div>

          <button
            className="theater-chat-toggle"
            onClick={() => setFullscreenChatHidden((current) => !current)}
            title="Toggle fullscreen chat (T)"
          >
            {fullscreenChatHidden ? <MessageCircle size={18} /> : <X size={18} />}
          </button>

          {!fullscreenChatHidden && recentMessages.length > 0 && (
            <div className="theater-chat">
              {recentMessages.map((item) => (
                <p key={item.id}>
                  <strong>{item.name}</strong>
                  <span>{item.message}</span>
                </p>
              ))}
            </div>
          )}

          {!fullscreenChatHidden && theaterMode && (
            <form className="theater-chat-form" onSubmit={sendChat}>
              <input
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Chat without leaving fullscreen..."
              />
              <button title="Send chat">
                <Send size={16} />
              </button>
            </form>
          )}

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

          {playerWarning && (
            <div className="player-warning">
              <strong>Video issue</strong>
              <span>{playerWarning}</span>
              <div>
                <button onClick={retryMovieLoad}>Retry</button>
                <button onClick={() => setPlayerWarning("")}>Dismiss</button>
              </div>
            </div>
          )}

          {movieLoadWarning && !playerWarning && (
            <button className="player-warning-chip" onClick={showMovieWarning}>
              Video issue
            </button>
          )}
        </div>

        <aside className="side">
          <div className={`toolbar ${isHost ? "" : "viewer-tools"}`}>
            {isHost && (
              <label className={`file-button ${localUrl ? "loaded" : ""}`}>
                {localUrl ? <FileVideo size={18} /> : <Upload size={18} />}
                {uploading ? `Uploading ${uploadProgress}%` : localUrl ? "Change Movie" : "Upload Movie"}
                <input type="file" accept="video/mp4,video/webm,video/ogg,.mp4,.m4v,.webm,.ogv,.ogg,.mkv" onChange={chooseFile} />
              </label>
            )}
            {isHost && (
              <button className={movieSource === "screen" ? "active" : ""} onClick={shareScreen} title="Share screen with audio">
                <MonitorUp size={18} />
              </button>
            )}
            <button className={device.audio ? "active" : ""} onClick={() => toggleDevice("audio")} title="Toggle mic">
              {device.audio ? <Mic size={18} /> : <MicOff size={18} />}
            </button>
            <button className={device.video ? "active" : ""} onClick={() => toggleDevice("video")} title="Toggle camera">
              {device.video ? <Camera size={18} /> : <CameraOff size={18} />}
            </button>
            <button onClick={restartCallLayer} title="Reconnect voice/video">
              <RefreshCw size={18} />
            </button>
            <button onClick={toggleFullscreen} title="Fullscreen">
              <Maximize2 size={18} />
            </button>
            {isHost && (
              <button className="danger" onClick={endRoom} title="End room and delete movie">
                <DoorClosed size={18} />
              </button>
            )}
            {!isHost && (
              <button className="danger" onClick={leaveRoom} title="Exit room">
                <LogOut size={18} />
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
                {isHost && !person.host && (
                  <button className="kick" onClick={() => kickPerson(person)} title={`Remove ${person.name}`}>
                    <UserX size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="call-grid">
            {localMediaStream && <VideoTile stream={localMediaStream} name="You" muted />}
            {remoteMediaList.map((item) => (
              <VideoTile
                key={item.peerId}
                stream={item.stream}
                name={item.name}
                onPlaybackBlocked={() => setNeedsPlaybackGesture(true)}
              />
            ))}
            {missingMediaPeople.map((person) => (
              <CallPlaceholder key={person.id} person={person} />
            ))}
          </div>

          <div className="reactions">
            {reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                onClick={() => sendReaction(reaction.emoji)}
                title={`${reaction.label} (${reaction.key})`}
              >
                <span>{reaction.emoji}</span>
                <small>{reaction.key}</small>
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
          <input ref={chatInputRef} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Say something..." />
          <button>
            <Send size={18} />
          </button>
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
