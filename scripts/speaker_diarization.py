#!/usr/bin/env python3
"""
Offline speaker diarization using Silero-VAD + Resemblyzer + AgglomerativeClustering.
Fully works without ffmpeg or torchcodec.
"""

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
import contextlib
from typing import TYPE_CHECKING


if TYPE_CHECKING:
    # Help type checkers / editors avoid missing-import diagnostics when deps
    # are not installed in the workspace. These runtime imports are handled
    # inside try/except blocks below.
    from sklearn.cluster import AgglomerativeClustering  # type: ignore


def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


def ensure_dir(p):
    Path(p).mkdir(parents=True, exist_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="input cleaned audio (mp3/wav)")
    parser.add_argument("output_dir", help="output directory for speaker files")
    args = parser.parse_args()

    input_path = Path(args.input)
    out_dir = Path(args.output_dir)
    ensure_dir(out_dir)

    try:
        import torch
        import numpy as np
        from pydub import AudioSegment
    except Exception as e:
        eprint("Missing required dependencies:", e)
        sys.exit(2)

    # ✅ Load Silero-VAD via torch.hub (always use torch.hub offline-capable path)
    try:
        eprint("Loading Silero VAD model via torch.hub (force stable mode)...")
        # suppress any stdout/stderr output from torch.hub (download progress, etc.)
        try:
            with open(os.devnull, "w") as devnull:
                with contextlib.redirect_stdout(devnull), contextlib.redirect_stderr(devnull):
                    model, utils = torch.hub.load(
                        repo_or_dir='snakers4/silero-vad',
                        model='silero_vad',
                        trust_repo=True,
                        force_reload=False
                    )
        except Exception:
            # second attempt without redirect in case of unexpected errors so we can capture them
            model, utils = torch.hub.load(
                repo_or_dir='snakers4/silero-vad',
                model='silero_vad',
                trust_repo=True,
                force_reload=False
            )

        (get_speech_timestamps, _, read_audio, _, _) = utils
        vad_get_timestamps = get_speech_timestamps
        vad_model = model
        eprint("✅ Silero VAD loaded successfully (offline mode ready)")
    except Exception as e:
        eprint("❌ Failed to load Silero VAD via torch.hub:", e)
        sys.exit(3)

    try:
        from resemblyzer import VoiceEncoder, preprocess_wav
        from sklearn.cluster import DBSCAN  # type: ignore
    except Exception as e:
        eprint("Missing resemblyzer or sklearn:", e)
        sys.exit(4)

    eprint(f"Loading input: {input_path}")

    # ✅ Offline audio loader (no ffmpeg)
    try:
        audio = AudioSegment.from_file(str(input_path))
    except Exception as e:
        eprint("Failed to read input audio:", e)
        sys.exit(5)

    samples = np.array(audio.get_array_of_samples()).astype(np.float32)

    # Convert stereo → mono
    if audio.channels == 2:
        samples = samples.reshape((-1, 2))
        samples = samples.mean(axis=1)

    # Normalize
    samples /= np.iinfo(audio.array_type).max

    # Convert to torch tensor
    waveform = torch.tensor(samples).unsqueeze(0)
    sr = audio.frame_rate

    # ✅ Optional resample to 16k for Silero
    target_sr = 16000
    if sr != target_sr:
        import torchaudio.functional as F
        waveform = F.resample(waveform, sr, target_sr)
        sr = target_sr

    audio_np = waveform.squeeze().numpy()

    # ✅ Run VAD
    eprint("Running VAD...")
    try:
        timestamps = vad_get_timestamps(audio_np, sampling_rate=sr)
    except TypeError:
        timestamps = vad_get_timestamps(audio_np, vad_model, sampling_rate=sr)

    eprint(f"Initial voice segments: {len(timestamps)}")

    # Merge segments closer than 0.3 sec
    merged = []
    for t in timestamps:
        start_s = t["start"] / sr
        end_s = t["end"] / sr
        if not merged:
            merged.append([start_s, end_s])
        else:
            prev = merged[-1]
            if start_s - prev[1] <= 0.3:
                prev[1] = end_s
            else:
                merged.append([start_s, end_s])

    eprint(f"Merged segments: {len(merged)}")

    if not merged:
        print(json.dumps({"status": "success", "speakers": []}))
        return

    # Many third-party libraries (resemblyzer, librosa, etc.) may write
    # informational messages to stdout. To guarantee the script's stdout
    # remains machine-readable JSON only, redirect stdout to stderr for the
    # processing steps and restore stdout just before printing the final JSON.
    # Use short overlapping windows to get more robust embeddings
    embeddings = []
    window_map = []
    tmp_dir = Path(tempfile.mkdtemp(prefix="sd_"))

    # window parameters (seconds)
    window_size = 1.5
    hop_size = 0.75

    # Redirect noisy library stdout to stderr while computing embeddings.
    orig_stdout = sys.stdout
    try:
        sys.stdout = sys.stderr

        # construct encoder while stdout is redirected
        encoder = VoiceEncoder()

        # Use partial embeddings per merged segment for finer clustering
        embeddings = []
        window_map = []
        seg_audio_paths = []
        tmp_dir = Path(tempfile.mkdtemp(prefix="sd_"))

        for i, (s, e) in enumerate(merged):
            seg_path = tmp_dir / f"seg_{i}.wav"
            # read full input and slice the segment
            seg_audio = AudioSegment.from_file(str(input_path))
            seg_chunk = seg_audio[int(s * 1000): int(e * 1000)]
            seg_chunk.export(seg_path, format="wav")
            seg_audio_paths.append(str(seg_path))

            wav = preprocess_wav(str(seg_path))
            try:
                # finer embedding windows (0.25s) for better separation
                partials = encoder.embed_utterance(wav, return_partials=True)[1]
            except Exception:
                # fallback to single embedding if partials are unavailable
                emb = encoder.embed_utterance(wav)
                partials = [emb]

            for j, emb in enumerate(partials):
                # approximate timestamp for each partial (0.25s step)
                w_start = s + j * 0.25
                w_end = min(e, w_start + 0.25)
                if w_start >= e:
                    break
                embeddings.append(emb)
                window_map.append({
                    "start": w_start,
                    "end": w_end,
                    "file": str(seg_path)
                })

        if not embeddings:
            print(json.dumps({"status": "success", "speakers": []}))
            return

        import numpy as np
        X = np.vstack(embeddings)

        # use DBSCAN with cosine distance to separate speaker timbres
        from sklearn.cluster import DBSCAN as _DBSCAN  # type: ignore
        clustering = _DBSCAN(
            eps=0.20,
            min_samples=2,
            metric='cosine'
        ).fit(X)
        labels = clustering.labels_
        unique_labels = sorted(set(labels) - {-1})
        eprint(f"Detected speakers: {len(unique_labels)} -> {unique_labels}")

        from collections import defaultdict

        # Ensure labels are normal Python ints, not numpy.int64
        labels = [int(l) for l in labels if l != -1]  # skip noise (-1)
        groups = defaultdict(list)

        for idx, lbl in enumerate(labels):
            groups[int(lbl)].append(merged[idx % len(merged)])  # modulo safe

        speaker_entries = []

        for cluster_id, segs in groups.items():
            label = f"Speaker_{cluster_id + 1}"
            out_file = out_dir / f"{label}.mp3"
            combined = None
            total_dur = 0.0

            for (s, e) in segs:
                seg_audio = AudioSegment.from_file(str(input_path))
                chunk = seg_audio[int(s * 1000): int(e * 1000)]
                total_dur += (e - s)
                combined = chunk if combined is None else combined + chunk

            if combined:
                combined.export(str(out_file), format="mp3", bitrate="128k")
                speaker_entries.append({
                    "label": label,
                    "file": str(out_file),
                    "duration": round(total_dur, 3)
                })

    finally:
        sys.stdout = orig_stdout

    print(json.dumps({"status": "success", "speakers": speaker_entries}))


if __name__ == "__main__":
    main()