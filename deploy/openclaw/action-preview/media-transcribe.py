"""Offline speech recognition. Called only with a verified, bounded local WAV."""
import contextlib
import json
import sys
import wave
import array

import mlx_whisper

with wave.open(sys.argv[1], "rb") as audio:
    samples = array.array("h", audio.readframes(audio.getnframes()))
# Exact digital silence should never become fabricated speech.
if not samples or max(abs(sample) for sample in samples) <= 2:
    json.dump({"text": "", "segments": [], "digital_silence": True,
               "automatic_transcript": True}, sys.stdout)
    sys.exit(0)

with contextlib.redirect_stdout(sys.stderr):
    result = mlx_whisper.transcribe(
        sys.argv[1], path_or_hf_repo=sys.argv[2], verbose=False,
        condition_on_previous_text=False, temperature=0.0,
    )
segments = [
    {key: item[key] for key in ("start", "end", "text", "avg_logprob", "no_speech_prob")}
    for item in result.get("segments", [])
]
json.dump({"text": result["text"], "language": result.get("language"),
           "segments": segments, "automatic_transcript": True}, sys.stdout)
