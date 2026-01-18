#!/usr/bin/env python3
"""
audio_pipeline.py

Usage examples:
  python scripts/audio_pipeline.py --input public/uploads/original_123.mp3
  python scripts/audio_pipeline.py --input public/uploads/original_123.mp3 --output tmp/processed_meet.wav
  python scripts/audio_pipeline.py --input public/uploads/original_123.mp3 --download-rnnoise

This script runs a robust FFmpeg filter chain to denoise, normalize and
prepare audio for ASR/diarization. It optionally downloads an RNNoise model
and uses `arnndn` if available; otherwise it falls back to `afftdn`.

Note: The script requires `ffmpeg` available on PATH. On Debian/Ubuntu you can
install with: `sudo apt-get install -y ffmpeg`.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path
import urllib.request
import time
import os


RNNOISE_URL = (
    "https://huggingface.co/ydf0509/rnnoise-models/resolve/main/cleanvoice.rnnn"
)


def ffmpeg_exists() -> bool:
    return shutil.which("ffmpeg") is not None


def download_rnnoise(dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading RNNoise model to {dest} ...")
    try:
        urllib.request.urlretrieve(RNNOISE_URL, str(dest))
    except Exception as e:
        raise RuntimeError(f"Failed to download RNNoise model: {e}")
    print("RNNoise model downloaded")
    return dest


def build_filter_chain(rnnoise: Path | None) -> str:
    # If RNNoise model provided and ffmpeg supports arnndn, prefer it.
    if rnnoise and rnnoise.exists():
        denoise = f"arnndn=m={str(rnnoise)}"
    else:
        denoise = "afftdn=nf=-20"

    # Compose filters (match user's requested chain)
    filters = [
        denoise,
        "highpass=f=120",
        "highpass=f=100",
        "lowpass=f=8000",
        "acompressor=threshold=-25dB:ratio=2.5:attack=10:release=150",
        "loudnorm=I=-14:TP=-1.5:LRA=5",
        "alimiter=limit=0.98",
        "silenceremove=stop_periods=-1:stop_threshold=-50dB:stop_duration=0.3",
        "agate=range=0.03:threshold=-40dB:attack=10:release=100",
    ]

    return ",".join(filters)


def run_ffmpeg(input_path: Path, output_path: Path, rnnoise: Path | None) -> int:
    filter_chain = build_filter_chain(rnnoise)

    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-af",
        filter_chain,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-sample_fmt",
        "s16",
        str(output_path),
    ]

    print("Running ffmpeg with command:")
    print(" ".join(cmd))
    try:
        res = subprocess.run(cmd, check=False)
        return res.returncode
    except FileNotFoundError:
        print("ffmpeg not found on PATH.")
        return 127


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Audio preprocessing pipeline (FFmpeg)")
    p.add_argument("--input", type=Path, required=True, help="Input audio file")
    p.add_argument("--output", type=Path, help="Output path (wav). Defaults to processed_<inputstem>.wav in tmp/")
    p.add_argument("--rnnoise", type=Path, help="Path to RNNoise model file (optional)")
    p.add_argument("--download-rnnoise", action="store_true", help="Download RNNoise model to scripts/model.rnnn before processing")
    p.add_argument("--no-copy", action="store_true", help="Do not copy processed file into public/uploads")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    if not ffmpeg_exists():
        print("ffmpeg is not installed or not on PATH. Install ffmpeg (apt-get install -y ffmpeg) and retry.")
        return 2

    input_path = args.input
    if not input_path.exists():
        print(f"Input file not found: {input_path}")
        return 3

    tmp_dir = Path("tmp")
    tmp_dir.mkdir(parents=True, exist_ok=True)

    output_path = args.output or tmp_dir / f"processed_{input_path.stem}.wav"

    rnnoise_path = None
    if args.download_rnnoise:
        rnnoise_path = Path(__file__).resolve().parent / "model.rnnn"
        if not rnnoise_path.exists():
            try:
                download_rnnoise(rnnoise_path)
            except Exception as e:
                print(e)
                rnnoise_path = None
    elif args.rnnoise:
        rnnoise_path = args.rnnoise

    rc = run_ffmpeg(input_path, output_path, rnnoise_path)
    if rc != 0:
        print(f"ffmpeg failed with exit code {rc}")
        return rc
    print(f"\nProcessed file saved as: {output_path}")

    # By default, copy the processed output into public/uploads so the
    # application's static server can serve it. The CLI flag `--no-copy`
    # can be used to skip this step.
    if not args.no_copy:
        try:
            uploads_dir = Path(os.getcwd()) / "public" / "uploads"
            uploads_dir.mkdir(parents=True, exist_ok=True)
            timestamp = int(time.time())
            # Copy WAV
            dest_name_wav = f"processed_{timestamp}_{input_path.stem}{output_path.suffix}"
            dest_path_wav = uploads_dir / dest_name_wav
            shutil.copy2(output_path, dest_path_wav)
            print(f"Copied processed WAV to: {dest_path_wav}")
            # Also create an MP3 version for easier browser playback/storage
            mp3_name = f"processed_{timestamp}_{input_path.stem}.mp3"
            mp3_tmp = output_path.with_suffix(".mp3")
            mp3_path = Path(str(mp3_tmp))
            mp3_cmd = [
                "ffmpeg",
                "-y",
                "-i",
                str(output_path),
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "128k",
                str(mp3_path),
            ]
            print("Running ffmpeg to create MP3:", " ".join(mp3_cmd))
            try:
                spres = subprocess.run(mp3_cmd, check=False)
                if spres.returncode == 0 and mp3_path.exists():
                    dest_path_mp3 = uploads_dir / mp3_name
                    shutil.copy2(mp3_path, dest_path_mp3)
                    print(f"Copied processed MP3 to: {dest_path_mp3}")
                    print(f"PUBLIC_URL_PATH_WAV=/uploads/{dest_name_wav}")
                    print(f"PUBLIC_URL_PATH_MP3=/uploads/{mp3_name}")
                else:
                    print(f"Warning: ffmpeg failed to create mp3 (rc={spres.returncode})")
            except Exception as e:
                print(f"Warning: failed to create/copy mp3: {e}")
        except Exception as e:
            print(f"Warning: failed to copy to public/uploads: {e}")
    else:
        print("Info: --no-copy provided; skipping copy to public/uploads")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
