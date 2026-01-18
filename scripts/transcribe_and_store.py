import os
import time
import json
import argparse
from datetime import datetime
import os
import time
import json
import argparse
import requests
from dotenv import load_dotenv

load_dotenv()

ASSEMBLYAI_KEY = os.getenv("ASSEMBLYAI_API_KEY")
if not ASSEMBLYAI_KEY:
    # Print JSON error and exit 0 per requirements
    print(json.dumps({"error": "ASSEMBLYAI_API_KEY not set"}))
    raise SystemExit(0)

UPLOAD_ENDPOINT = "https://api.assemblyai.com/v2/upload"
TRANSCRIPT_ENDPOINT = "https://api.assemblyai.com/v2/transcript"
HEADERS = {"authorization": ASSEMBLYAI_KEY}

POLL_INTERVAL = 3
TIMEOUT = 600


def upload_file_to_assemblyai(file_path: str):
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Local file not found: {file_path}")
    with open(file_path, "rb") as fh:
        resp = requests.post(UPLOAD_ENDPOINT, data=fh, headers=HEADERS)
    resp.raise_for_status()
    data = resp.json()
    upload_url = data.get("upload_url")
    if not upload_url:
        raise RuntimeError(f"Upload failed, no upload_url returned: {data}")
    return upload_url


def create_transcription(audio_url, options=None):
    payload = {"audio_url": audio_url}
    if options:
        payload.update(options)
    r = requests.post(TRANSCRIPT_ENDPOINT, json=payload, headers=HEADERS)
    r.raise_for_status()
    return r.json()


def poll_transcript(transcript_id, poll_interval=POLL_INTERVAL, timeout=TIMEOUT):
    url = f"{TRANSCRIPT_ENDPOINT}/{transcript_id}"
    start = time.time()
    while True:
        r = requests.get(url, headers=HEADERS)
        r.raise_for_status()
        data = r.json()
        status = data.get("status")
        if status == "completed":
            return data
        if status == "error":
            return {"error": True, "detail": data}
        if time.time() - start > timeout:
            return {"error": True, "detail": "timeout"}
        time.sleep(poll_interval)


def main():
    parser = argparse.ArgumentParser(description="Transcribe local file using AssemblyAI")
    parser.add_argument("--file-path", type=str, required=True)
    parser.add_argument("--audio-id", type=int, required=True)
    args = parser.parse_args()

    out = {"audio_id": args.audio_id, "text": None, "full_json": None}
    try:
        upload_url = None
        # If provided path looks like a URL, use it directly
        if str(args.file_path).startswith("http://") or str(args.file_path).startswith("https://"):
            upload_url = args.file_path
        else:
            upload_url = upload_file_to_assemblyai(args.file_path)

        job = create_transcription(upload_url)
        tid = job.get("id")
        final = poll_transcript(tid)
        if final and isinstance(final, dict) and final.get("error"):
            out["text"] = None
            out["full_json"] = final.get("detail")
        else:
            text = final.get("text", "") if final else ""
            out["text"] = text
            out["full_json"] = final
    except Exception as e:
        out["text"] = None
        out["full_json"] = {"error": str(e)}

    # Print only the JSON object as required
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
    r.raise_for_status()
