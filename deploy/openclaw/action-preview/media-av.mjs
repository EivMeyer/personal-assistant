import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  rename,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const runtime = join(homedir(), ".local/share/secretary-runtime");
const cache = join(homedir(), ".local/share/secretary-media");
const pending = new Map();
async function command(binary, args, timeout = 45000) {
  try {
    return await execute(binary, args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    });
  } catch {
    throw Error(
      "Local media decoding/transcription failed; leave this window unread",
    );
  }
}
export function avWindow(probe, start) {
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 7200)
    throw Error("Media duration is missing or exceeds two hours");
  if (!Number.isInteger(start) || start < 0 || start >= duration || start % 30)
    throw Error("start_seconds must be an available 30-second window boundary");
  return {
    duration_seconds: duration,
    start_seconds: start,
    end_seconds: Math.min(start + 30, duration),
    next_start_seconds: start + 30 < duration ? start + 30 : null,
    has_audio: probe.streams.some((s) => s.codec_type === "audio"),
    has_video: probe.streams.some((s) => s.codec_type === "video"),
  };
}
async function modelPath() {
  const root = join(
    homedir(),
    ".cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo",
  );
  const revision = (await readFile(join(root, "refs/main"), "utf8")).trim();
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw Error("Invalid local transcription model revision");
  return join(root, "snapshots", revision);
}
async function speech(path, dir, window) {
  if (!window.has_audio)
    return { text: "", segments: [], no_audio_track: true };
  const wav = join(dir, "speech.wav");
  await command("/opt/homebrew/bin/ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    "mov,mp4,m4a,3gp,3g2,mj2,ogg,matroska,webm,mp3,wav,flac,aac,amr",
    "-ss",
    String(window.start_seconds),
    "-i",
    path,
    "-t",
    String(window.end_seconds - window.start_seconds),
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    wav,
  ]);
  const result = await command(
    join(runtime, "media-venv/bin/python"),
    [
      fileURLToPath(new URL("./media-transcribe.py", import.meta.url)),
      wav,
      await modelPath(),
    ],
    120000,
  );
  const transcript = JSON.parse(result.stdout);
  if (
    typeof transcript.text !== "string" ||
    !Array.isArray(transcript.segments)
  )
    throw Error("Invalid transcription output");
  return transcript;
}
async function frames(path, dir, window) {
  if (!window.has_video) return [];
  // A sampled overview, not proof of every frame. Times correspond to row-major cells.
  const times = Array.from(
    { length: Math.ceil((window.end_seconds - window.start_seconds) / 2) },
    (_, i) => window.start_seconds + i * 2,
  );
  await command("/opt/homebrew/bin/ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    "mov,mp4,m4a,3gp,3g2,mj2,ogg,matroska,webm,mp3,wav,flac,aac,amr",
    "-ss",
    String(window.start_seconds),
    "-i",
    path,
    "-t",
    String(window.end_seconds - window.start_seconds),
    "-an",
    "-vf",
    "fps=1/2:round=up,scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2,tile=4x4",
    "-frames:v",
    "1",
    "-q:v",
    "3",
    join(dir, "frames.jpg"),
  ]);
  return times;
}
async function createWindow(source, start, directory) {
  const dir = await mkdtemp(join(cache, "working-"));
  try {
    // Work on the verified bytes, not a mutable bridge cache path.
    const input = join(dir, "source.bin");
    await writeFile(input, source.bytes, { mode: 0o600 });
    const probe = await probeMedia(input);
    const window = avWindow(probe, start);
    if (source.kind === "video" && !window.has_video)
      throw Error("Video track is missing");
    if (source.kind === "audio" && !window.has_audio)
      throw Error("Audio track is missing");
    const transcript = await speech(input, dir, window);
    const frame_times = await frames(input, dir, window);
    const metadata = {
      source: "untrusted WhatsApp audio/video",
      source_sha256: source.sha256,
      media_type: source.kind,
      ...window,
      transcript,
      frame_times,
      visual_coverage: window.has_video
        ? "sampled every two seconds, 4x4 row-major overview; brief events may be missed"
        : null,
      transcript_caution:
        "Automatic speech recognition can be wrong; confirm uncertain names, numbers and commitments against the source.",
    };
    await writeFile(join(dir, "metadata.json"), JSON.stringify(metadata), {
      mode: 0o600,
    });
    await rm(input);
    await rm(join(dir, "speech.wav"), { force: true });
    await rename(dir, directory);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function analyzeAV(source, start) {
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const directory = join(cache, source.sha256 + "-v1-" + start);
  const metadataPath = join(directory, "metadata.json");
  try {
    await readFile(metadataPath);
  } catch {
    if (!pending.has(directory))
      pending.set(
        directory,
        createWindow(source, start, directory).finally(() =>
          pending.delete(directory),
        ),
      );
    await pending.get(directory);
  }
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  if (
    metadata.source_sha256 !== source.sha256 ||
    metadata.start_seconds !== start
  )
    throw Error("Cached analysis does not match source");
  const image = metadata.has_video
    ? await readFile(join(directory, "frames.jpg"))
    : null;
  metadata.transcript = transcriptQuality(metadata.transcript, start);
  return { metadata, image };
}

export function transcriptQuality(transcript, start = 0) {
  const segments = (transcript.segments ?? []).map((segment) => {
    const confidenceKnown =
      Number.isFinite(segment.avg_logprob) &&
      Number.isFinite(segment.no_speech_prob);
    const uncertain =
      !confidenceKnown ||
      segment.avg_logprob < -0.8 ||
      segment.no_speech_prob > 0.5;
    return {
      ...segment,
      source_start_seconds: start + segment.start,
      source_end_seconds: start + segment.end,
      uncertain,
    };
  });
  return {
    ...transcript,
    segments,
    review_required:
      Boolean(transcript.text?.trim()) &&
      (segments.length === 0 || segments.some((s) => s.uncertain)),
    accuracy_guaranteed: false,
  };
}

export async function videoFrame(source, at) {
  if (!Number.isFinite(at) || at < 0 || at > 7200)
    throw Error("Invalid frame timestamp");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(cache, "frame-"));
  try {
    const input = join(dir, "source.bin");
    await writeFile(input, source.bytes, { mode: 0o600 });
    const probe = await probeMedia(input);
    const window = avWindow(probe, Math.floor(at / 30) * 30);
    if (!window.has_video || at >= window.duration_seconds)
      throw Error("Video frame is outside the source");
    const output = join(dir, "frame.jpg");
    await command("/opt/homebrew/bin/ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm",
      "-ss",
      String(at),
      "-i",
      input,
      "-an",
      "-frames:v",
      "1",
      "-vf",
      "scale=1280:1280:force_original_aspect_ratio=decrease",
      "-q:v",
      "2",
      output,
    ]);
    return {
      image: await readFile(output),
      metadata: {
        source: "untrusted WhatsApp video frame",
        source_sha256: source.sha256,
        frame_seconds: at,
        duration_seconds: window.duration_seconds,
        visual_coverage:
          "one decoded frame near the requested timestamp; inspect nearby timestamps for brief motion",
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function probeMedia(input) {
  const result = await command("/opt/homebrew/bin/ffprobe", [
    "-v",
    "error",
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    "mov,mp4,m4a,3gp,3g2,mj2,ogg,matroska,webm,mp3,wav,flac,aac,amr",
    "-show_format",
    "-show_streams",
    "-of",
    "json",
    input,
  ]);
  return JSON.parse(result.stdout);
}
