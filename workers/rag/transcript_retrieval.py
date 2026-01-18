#!/usr/bin/env python3
"""
Transcript retrieval layer for call guardrails.

- Loads env from repo root .env
- Fetches transcript row from MySQL
- Embeds transcript with Gemini embeddings
- Queries Pinecone for top-K guardrail chunks filtered by company/team
- Returns clean JSON-serializable dict
"""

from __future__ import annotations

import os
import logging
from typing import Any, Dict, List, Optional
from pathlib import Path

import mysql.connector
from mysql.connector import pooling

# Env loading (same pattern used elsewhere)
try:
    from dotenv import load_dotenv
    _DOTENV_AVAILABLE = True
except Exception:
    load_dotenv = None
    _DOTENV_AVAILABLE = False

# Gemini
try:
    import google.generativeai as genai
except Exception:
    genai = None

LOG = logging.getLogger("transcript_retrieval")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


# ---------------------- Env helpers ----------------------
def env(key: str, default: Optional[str] = None) -> Optional[str]:
    return os.environ.get(key, default)


def load_repo_env():
    """Load .env from repository root (role-based-auth/.env) if present."""
    try:
        repo_root = Path(__file__).resolve().parents[3]
    except Exception:
        repo_root = Path(os.getcwd())
    env_path = repo_root / ".env"
    if env_path.exists():
        if _DOTENV_AVAILABLE:
            load_dotenv(dotenv_path=str(env_path), override=False)
            LOG.info("Loaded environment from %s", env_path)
        else:
            # Minimal fallback
            try:
                for line in env_path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip('"').strip("'")
                    if k not in os.environ:
                        os.environ[k] = v
                LOG.info("Loaded .env (fallback) from %s", env_path)
            except Exception:
                LOG.exception("Failed to read .env at %s", env_path)


# Load .env early
load_repo_env()


# ---------------------- DB setup ----------------------
DB_CONFIG = {
    "host": env("DB_HOST", "localhost"),
    "port": int(env("DB_PORT", "3306") or 3306),
    "user": env("DB_USER", "root"),
    "password": env("DB_PASSWORD", env("DB_PASS", "")),
    "database": env("DB_NAME", "sqldb"),
    "raise_on_warnings": True,
}

POOL: Optional[pooling.MySQLConnectionPool] = None


def init_db_pool(pool_name: str = "retrieval_pool", pool_size: int = 5):
    global POOL
    if POOL is None:
        POOL = pooling.MySQLConnectionPool(pool_name=pool_name, pool_size=pool_size, **DB_CONFIG)
    return POOL


def get_conn():
    if POOL is None:
        init_db_pool()
    return POOL.get_connection()


def get_transcript_row(recording_id: int) -> Dict[str, Any]:
    """
    Fetch a single row from audio_recordings by id.
    Return dict with keys: id, company_id, transcription.
    Raise a clear error if the row does not exist or transcription is NULL/empty.
    """
    conn = None
    cur = None
    try:
        conn = get_conn()
        cur = conn.cursor(dictionary=True)
        cur.execute(
            "SELECT id, company_id, transcription FROM audio_recordings WHERE id = %s",
            (recording_id,),
        )
        row = cur.fetchone()
        if not row:
            raise RuntimeError(f"Recording id {recording_id} not found")
        tx = row.get("transcription")
        if tx is None or (isinstance(tx, str) and tx.strip() == ""):
            raise RuntimeError(f"Recording id {recording_id} has empty or NULL transcription")
        return {
            "id": row.get("id"),
            "company_id": row.get("company_id"),
            "transcription": tx,
        }
    finally:
        try:
            if cur:
                cur.close()
        except Exception:
            pass
        try:
            if conn:
                conn.close()
        except Exception:
            pass


# ---------------------- Gemini embeddings ----------------------
EMBEDDING_MODEL = env("EMBEDDING_MODEL", "gemini-embedding-001")
GEMINI_API_KEY = env("GEMINI_API_KEY") or env("GOOGLE_API_KEY")

if genai is None:
    LOG.warning("google.generativeai not installed; install it to use embeddings")
else:
    try:
        if GEMINI_API_KEY:
            genai.configure(api_key=GEMINI_API_KEY)
            LOG.info("Configured genai with provided API key")
    except Exception:
        LOG.exception("Failed to configure genai; relying on application credentials if available")


def embed_transcript(transcript: str) -> List[float]:
    """
    Use google.generativeai.embed_content with EMBEDDING_MODEL.
    Handle result formats that use either .embedding or ['embedding'], 
    and if the embedding is a dict with 'values', return that list.
    """
    if genai is None:
        raise RuntimeError("google.generativeai not available")
    if not transcript or not transcript.strip():
        raise RuntimeError("Transcript is empty")

    resp = None
    if hasattr(genai, "embed_content"):
        resp = genai.embed_content(model=EMBEDDING_MODEL, content=transcript)
    elif hasattr(genai, "embed_content_async"):
        fut = genai.embed_content_async(model=EMBEDDING_MODEL, content=transcript)
        resp = fut.result() if hasattr(fut, "result") else fut
    else:
        raise RuntimeError("genai.embed_content not available in installed package")

    # Extract embedding from possible shapes
    # dict: {"embedding": {"values": [...]}} OR {"embedding": [...]}
    if isinstance(resp, dict) and "embedding" in resp:
        emb = resp["embedding"]
        if isinstance(emb, dict) and "values" in emb:
            return list(emb["values"])  # type: ignore
        if isinstance(emb, list):
            return list(emb)
    # dict: {"embeddings": [{"values": [...]}]}
    if isinstance(resp, dict) and "embeddings" in resp and isinstance(resp["embeddings"], list):
        first = resp["embeddings"][0] if resp["embeddings"] else None
        if isinstance(first, dict) and "values" in first:
            return list(first["values"])  # type: ignore
    # object attributes: resp.embedding.values or resp.embedding (list)
    if hasattr(resp, "embedding"):
        emb_attr = getattr(resp, "embedding")
        if hasattr(emb_attr, "values"):
            return list(getattr(emb_attr, "values"))  # type: ignore
        if isinstance(emb_attr, list):
            return list(emb_attr)

    raise RuntimeError("Failed to extract embedding from Gemini response")


# ---------------------- Pinecone setup ----------------------
PINECONE_API_KEY = env("PINECONE_API_KEY")
PINECONE_INDEX_NAME = env("PINECONE_INDEX_NAME")
PINECONE_HOST = env("PINECONE_HOST")


def get_pinecone_index():
    """
    Initialize Pinecone client using the new Pinecone SDK style and return the Index.
    Requires PINECONE_API_KEY, PINECONE_INDEX_NAME, and PINECONE_HOST.
    """
    if not PINECONE_API_KEY or not PINECONE_INDEX_NAME or not PINECONE_HOST:
        raise RuntimeError("Pinecone requires PINECONE_API_KEY, PINECONE_INDEX_NAME and PINECONE_HOST")

    try:
        # Use the new Pinecone SDK style
        from pinecone import Pinecone
    except Exception:
        raise RuntimeError("Pinecone client not found. Install with: pip install pinecone-client or pinecone")

    try:
        client = Pinecone(api_key=PINECONE_API_KEY, host=PINECONE_HOST)
        index = client.Index(PINECONE_INDEX_NAME)
        return index
    except Exception as e:
        LOG.exception("Failed to initialize Pinecone (new SDK): %s", e)
        raise


# ---------------------- Retrieval pipeline ----------------------
def query_transcript_guardrails_for_recording(
    recording_id: int,
    top_k: int = 8,
) -> Dict[str, Any]:
    """
    High-level pipeline for Layer 2 retrieval:
    1. Load audio_recordings row by id.
    2. Embed the transcript using embed_transcript().
    3. Build a Pinecone metadata filter by company_id only.
    4. Query Pinecone index with:
       - vector = transcript embedding
       - top_k = given top_k
       - include_metadata = True
       - filter = { "company_id": company_id }
    5. Return a dict with matches and recording info.
    """
    row = get_transcript_row(recording_id)
    company_id = row.get("company_id")
    transcription = row.get("transcription")
    user_id = None  # reserved for future, not stored in audio_recordings

    vec = embed_transcript(transcription)
    index = get_pinecone_index()

    # Build metadata filter
    flt: Dict[str, Any] = {}
    if company_id is not None:
        try:
            flt["company_id"] = int(company_id)
        except Exception:
            flt["company_id"] = company_id

    # Query Pinecone
    try:
        res = index.query(vector=vec, top_k=int(top_k), include_metadata=True, filter=flt)
    except Exception:
        LOG.exception("Pinecone query failed")
        raise

    matches_out: List[Dict[str, Any]] = []
    # res.matches may vary in shape across versions
    try:
        matches = getattr(res, "matches", None)
    except Exception:
        matches = None
    if isinstance(res, dict) and "matches" in res:
        matches = res["matches"]

    if not matches:
        return {
            "recording_id": recording_id,
            "company_id": company_id,
            "user_id": user_id,
            "top_k": top_k,
            "matches": [],
        }

    for m in matches:
        try:
            pid = getattr(m, "id", None) or (m.get("id") if isinstance(m, dict) else None)
            score = getattr(m, "score", None) or (m.get("score") if isinstance(m, dict) else None)
            meta = getattr(m, "metadata", None) or (m.get("metadata") if isinstance(m, dict) else {})
        except Exception:
            pid, score, meta = None, None, {}
        # Log a short preview of the retrieved chunk for observability (does not change output)
        try:
            chunk_text = meta.get("chunk_text") if isinstance(meta, dict) else None
            preview = "" if not chunk_text else str(chunk_text).replace("\n", " ")[:120]
            LOG.info("Pinecone match score=%s preview=%s", score, preview)
        except Exception:
            pass

        matches_out.append({
            "id": pid,
            "score": float(score) if score is not None else None,
            "chunk_text": meta.get("chunk_text"),
            "company_id": meta.get("company_id"),
            "team_id": meta.get("team_id"),
            "doc_id": meta.get("doc_id"),
            "doc_name": meta.get("doc_name"),
            "table": meta.get("table"),
            "source_path": meta.get("source_path"),
            "chunk_index": meta.get("chunk_index"),
        })

    return {
        "recording_id": recording_id,
        "company_id": company_id,
        "user_id": user_id,
        "top_k": top_k,
        "matches": matches_out,
    }


# ---------------------- CLI ----------------------
if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Transcript guardrail retrieval")
    parser.add_argument("recording_id", type=int)
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument(
        "--json", action="store_true", help="Print JSON instead of pretty text"
    )
    args = parser.parse_args()

    result = query_transcript_guardrails_for_recording(
        recording_id=args.recording_id,
        top_k=args.top_k,
    )

    if args.json:
        print(json.dumps(result, default=str))
    else:
        from pprint import pprint
        pprint(result)
