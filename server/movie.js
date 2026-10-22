import ffprobeStatic from "ffprobe-static";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { deleteR2Prefix, downloadR2Object, publicR2Url, uploadR2File } from "./r2.js";

const require = createRequire(import.meta.url);
let bundledFfmpeg = null;
try {
  bundledFfmpeg = require("ffmpeg-static");
} catch {}
const execFileAsync = promisify(execFile);
const ffmpegPath = process.env.FFMPEG_PATH || bundledFfmpeg || "ffmpeg";
const bundledProbe = ffprobeStatic.path;
const ffprobePath = process.env.FFPROBE_PATH || (existsSync(bundledProbe) ? bundledProbe : "ffprobe");
const maxAudioTracks = 16;

function trackLabel(stream, index) {
  const title = stream.tags?.title?.trim();
  const language = stream.tags?.language?.trim();
  const channels = stream.channels ? `${stream.channels === 2 ? "Stereo" : `${stream.channels}ch`}` : "";
  return title || [language && language !== "und" ? language.toUpperCase() : null, channels].filter(Boolean).join(" · ") || `Audio ${index + 1}`;
}

async function inspectMovie(filepath) {
  const { stdout } = await execFileAsync(ffprobePath, [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", filepath
  ], { maxBuffer: 16 * 1024 * 1024 });
  const metadata = JSON.parse(stdout);
  const video = metadata.streams?.find((stream) => stream.codec_type === "video");
  const audio = metadata.streams?.filter((stream) => stream.codec_type === "audio") || [];
  if (!video) throw new Error("This file does not contain a video track.");
  if (audio.length > maxAudioTracks) throw new Error(`This movie has more than ${maxAudioTracks} audio tracks.`);
  return {
    video,
    audio,
    duration: Number(metadata.format?.duration || video.duration || 0),
    tracks: audio.map((stream, index) => ({
      index,
      label: trackLabel(stream, index),
      language: stream.tags?.language || "",
      channels: stream.channels || null,
      codec: stream.codec_name || "unknown",
      default: Boolean(stream.disposition?.default)
    }))
  };
}

function hlsTrackName(label) {
  return label.normalize("NFKD").replace(/[^\w .()-]/g, "").replace(/[\s,=:/\\]+/g, "_").slice(0, 48) || "Audio";
}

function runFfmpeg(inputPath, outputDir, metadata, onProgress) {
  const streamMap = [];
  const args = ["-hide_banner", "-y", "-i", inputPath, "-map", "0:v:0"];
  for (let index = 0; index < metadata.audio.length; index += 1) {
    args.push("-map", `0:a:${index}`);
  }

  const compatibleVideo = metadata.video.codec_name === "h264" && metadata.video.pix_fmt === "yuv420p";
  if (compatibleVideo) {
    args.push("-c:v:0", "copy");
  } else {
    args.push("-c:v:0", "libx264", "-preset", process.env.FFMPEG_PRESET || "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-profile:v", "high");
  }

  if (metadata.audio.length) {
    args.push("-c:a", "aac", "-b:a", process.env.HLS_AUDIO_BITRATE || "256k");
    const defaultAudioIndex = Math.max(0, metadata.tracks.findIndex((track) => track.default));
    metadata.tracks.forEach((track, index) => {
      const language = /^[a-zA-Z]{2,3}$/.test(track.language) ? track.language.toLowerCase() : "und";
      streamMap.push(`a:${index},agroup:cinemate-audio,name:${hlsTrackName(track.label)},language:${language},default:${index === defaultAudioIndex ? "yes" : "no"}`);
    });
    streamMap.push("v:0,agroup:cinemate-audio");
  } else {
    streamMap.push("v:0");
  }

  args.push(
    "-f", "hls",
    "-hls_time", "6",
    "-hls_list_size", "0",
    "-hls_playlist_type", "vod",
    "-hls_flags", "single_file+independent_segments",
    "-var_stream_map", streamMap.join(" "),
    "-master_pl_name", "master.m3u8",
    "-hls_segment_filename", join(outputDir, "stream_%v.ts"),
    "-progress", "pipe:1",
    "-nostats",
    join(outputDir, "stream_%v.m3u8")
  );

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuffer = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const [key, value] = line.split("=", 2);
        if (key === "out_time_us" && metadata.duration > 0) {
          onProgress?.(Math.min(99, Math.floor((Number(value) / 1_000_000 / metadata.duration) * 100)));
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12000);
    });
    child.on("error", (error) => reject(new Error(`Could not start FFmpeg: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) {
        onProgress?.(100);
        resolve();
      } else {
        reject(new Error(`FFmpeg could not prepare this movie. ${stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(" ")}`));
      }
    });
  });
}

async function createHls(inputPath, outputDir, onProgress) {
  const metadata = await inspectMovie(inputPath);
  await runFfmpeg(inputPath, outputDir, metadata, onProgress);
  return metadata;
}

function contentType(filename) {
  switch (extname(filename).toLowerCase()) {
    case ".m3u8": return "application/vnd.apple.mpegurl";
    case ".ts": return "video/mp2t";
    default: return "application/octet-stream";
  }
}

export async function packageR2Movie({ roomCode, key, onProgress }) {
  const tempBase = process.env.CINEMATE_TMP_DIR || tmpdir();
  await mkdir(tempBase, { recursive: true });
  const workingDir = await mkdtemp(join(tempBase, "cinemate-"));
  const inputPath = join(workingDir, basename(key));
  const outputDir = join(workingDir, "hls");
  const prefix = `rooms/${roomCode}/${Date.now()}-hls`;
  try {
    await downloadR2Object(key, inputPath);
    await mkdir(outputDir, { recursive: true });
    const metadata = await createHls(inputPath, outputDir, (progress) => {
      onProgress?.(Math.min(88, Math.floor(progress * 0.88)));
    });
    const files = await readdir(outputDir);
    for (let index = 0; index < files.length; index += 1) {
      const filename = files[index];
      const outputKey = `${prefix}/${filename}`;
      await uploadR2File(outputKey, join(outputDir, filename), contentType(filename));
      onProgress?.(90 + Math.floor(((index + 1) / files.length) * 9));
    }
    onProgress?.(100);
    return {
      mediaUrl: publicR2Url(`${prefix}/master.m3u8`),
      r2Prefix: `${prefix}/`,
      hlsTracks: metadata.tracks,
      audioTrackIndex: Math.max(0, metadata.tracks.findIndex((track) => track.default)),
      encodedVideo: !(metadata.video.codec_name === "h264" && metadata.video.pix_fmt === "yuv420p")
    };
  } catch (error) {
    await deleteR2Prefix(`${prefix}/`).catch(() => {});
    throw error;
  } finally {
    await rm(workingDir, { recursive: true, force: true });
  }
}

export async function packageLocalMovie({ inputPath, outputDir, mediaBaseUrl, onProgress }) {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const metadata = await createHls(inputPath, outputDir, onProgress);
  return {
    mediaUrl: `${mediaBaseUrl.replace(/\/$/, "")}/master.m3u8`,
    hlsTracks: metadata.tracks,
    audioTrackIndex: Math.max(0, metadata.tracks.findIndex((track) => track.default)),
    encodedVideo: !(metadata.video.codec_name === "h264" && metadata.video.pix_fmt === "yuv420p")
  };
}
