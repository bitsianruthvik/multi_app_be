#!/usr/bin/env python3
"""
Document ingestion script (event-driven, no background loop)

- Reads a single document row from company_documents or team_documents
- Resolves local or remote file
- Extracts text (PDF via pdfplumber, fallback to text)
- Chunks text
- Writes chunks to RAG_DATA_DIR
- Optionally marks DB row as ingested

Designed for:
- Manual dry-run
- Direct backend-triggered execution
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import tempfile
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional, List
from urllib.parse import urlparse

import requests
import mysql.connector
from mysql.connector import pooling

# ------------------------------------------------------
# Robust .env loader (Windows-safe, path-safe)
# ------------------------------------------------------
try:
    from dotenv import load_dotenv
except Exception:
    load_dotenv = None


def load_env() -> Optional[Path]:
    p = Path(__file__).resolve()
    for parent in [p] + list(p.parents):
        env_file = parent / ".env"
        if env_file.exists():
            if load_dotenv:
                load_dotenv(env_file, override=False)
            return parent
    return None


REPO_ROOT = load_env()

# ------------------------------------------------------
# Logging
# ------------------------------------------------------
LOG = logging.getLogger("rag_ingest")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ------------------------------------------------------
# Helpers
# ------------------------------------------------------
def env(key: str, default: Optional[str] = None) -> Optional[str]:
    return os.environ.get(key, default)

# ------------------------------------------------------
# DB CONFIG (env-driven)
# ------------------------------------------------------
DB_CONFIG = {
    "host": env("DB_HOST", "localhost"),
    "port": int(env("DB_PORT", "3306")),
    "user": env("DB_USER", "root"),
    "password": env("DB_PASSWORD", ""),
    "database": env("DB_NAME", "sqldb"),
}

# ------------------------------------------------------
# ENV SETTINGS
# ------------------------------------------------------
LOCAL_UPLOAD_DIR = Path(
    env("LOCAL_UPLOAD_DIR", str(REPO_ROOT / "public" / "uploads" if REPO_ROOT else "public/uploads"))
)

RAG_DATA_DIR = env("RAG_DATA_DIR")
if not RAG_DATA_DIR and REPO_ROOT:
    RAG_DATA_DIR = str(REPO_ROOT / "rag" / "data")

STORAGE_BASE_URL = env("STORAGE_BASE_URL")

CHUNK_SIZE = int(env("CHUNK_SIZE", "350"))
CHUNK_OVERLAP = int(env("CHUNK_OVERLAP", "50"))

# ------------------------------------------------------
# Optional PDF support
# ------------------------------------------------------
try:
    import pdfplumber
except Exception:
    pdfplumber = None

# ------------------------------------------------------
# DB Pool
# ------------------------------------------------------
POOL: Optional[pooling.MySQLConnectionPool] = None


def init_db_pool():
    global POOL
    if POOL is None:
        POOL = pooling.MySQLConnectionPool(pool_name="rag_pool", pool_size=5, **DB_CONFIG)


def get_conn():
    if POOL is None:
        init_db_pool()
    return POOL.get_connection()

# ------------------------------------------------------
# Networking
# ------------------------------------------------------
def http_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": "rag-ingest/1.0"})
    return s


def download_temp(url: str, session: requests.Session) -> str:
    LOG.info("Downloading %s", url)
    with session.get(url, stream=True, timeout=30) as r:
        r.raise_for_status()
        fd, path = tempfile.mkstemp()
        os.close(fd)
        with open(path, "wb") as f:
            for chunk in r.iter_content(8192):
                if chunk:
                    f.write(chunk)
        return path

# ------------------------------------------------------
# Text extraction
# ------------------------------------------------------
def extract_text(path: str) -> str:
    if path.lower().endswith(".pdf"):
        if not pdfplumber:
            raise RuntimeError("pdfplumber not installed")
        texts: List[str] = []
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                t = page.extract_text()
                if t:
                    texts.append(t)
        return "\n".join(texts)

    with open(path, "rb") as f:
        data = f.read()

    try:
        return data.decode("utf-8")
    except Exception:
        return data.decode("latin-1")

# ------------------------------------------------------
# Chunking
# ------------------------------------------------------
def chunk_text(text: str) -> List[str]:
    words = re.findall(r"\S+", text)
    if not words:
        return []

    chunks: List[str] = []
    step = max(1, CHUNK_SIZE - CHUNK_OVERLAP)

    for i in range(0, len(words), step):
        chunk = words[i : i + CHUNK_SIZE]
        chunks.append(" ".join(chunk))
        if i + CHUNK_SIZE >= len(words):
            break

    return chunks

# ------------------------------------------------------
# Result model
# ------------------------------------------------------
@dataclass
class ProcessResult:
    doc_table: str
    doc_id: int
    chunks_count: int
    status: str
    error: Optional[str] = None

# ------------------------------------------------------
# Core ingestion
# ------------------------------------------------------
def ingest_single(table: str, doc_id: int, mark: bool) -> ProcessResult:
    # For backward compatibility keep ingest_single but delegate to ingest_in_memory
    try:
        result = ingest_in_memory(table, doc_id)
        chunks = result.get("chunks", [])
        # Optional DB mark
        if mark:
            conn = get_conn()
            cur = conn.cursor()
            try:
                cur.execute(f"UPDATE `{table}` SET ingested = 1 WHERE id = %s", (doc_id,))
                conn.commit()
            finally:
                try:
                    cur.close()
                except Exception:
                    pass
                try:
                    conn.close()
                except Exception:
                    pass
        return ProcessResult(table, doc_id, len(chunks), "success")
    except Exception as e:
        LOG.exception("Ingestion failed")
        return ProcessResult(table, doc_id, 0, "failed", str(e))

# ------------------------------------------------------
# CLI
# ------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Event-driven document ingestion")
    parser.add_argument("--single", nargs=2, metavar=("TABLE", "ID"), required=True)
    parser.add_argument("--mark", action="store_true")
    args = parser.parse_args()

    table, sid = args.single
    result = ingest_single(table, int(sid), args.mark)
    print(json.dumps(asdict(result), indent=2))


if __name__ == "__main__":
    main()


# -----------------------------
# New: in-memory ingestion API
# -----------------------------
def ingest_in_memory(table: str, doc_id: int) -> dict:
    """Ingest a document into memory.

    Returns a dict:
    {
      "chunks": List[str],
      "metadata": { "table": table, "doc_id": doc_id, "company_id": int|None, "team_id": int|None, "doc_name": str }
    }
    """
    conn = None
    session = http_session()
    tmp_file: Optional[str] = None
    try:
        conn = get_conn()
        cur = conn.cursor(dictionary=True)
        cur.execute(f"SELECT * FROM `{table}` WHERE id = %s", (doc_id,))
        row = cur.fetchone()
        cur.close()

        if not row:
            raise RuntimeError("Row not found")

        doc_path = row.get("doc_path") or ""
        parsed = urlparse(doc_path)

        # Resolve source file (download to temp if remote)
        if parsed.scheme in ("http", "https"):
            tmp_file = download_temp(doc_path, session)
            source = tmp_file
        else:
            source = LOCAL_UPLOAD_DIR / Path(doc_path).name
            if not source.exists():
                raise FileNotFoundError(doc_path)

        text = extract_text(str(source))
        chunks = chunk_text(text)

        metadata = {
            "table": table,
            "doc_id": int(doc_id),
            "company_id": row.get("company_id"),
            "team_id": row.get("team_id"),
            "doc_name": row.get("doc_name") or Path(doc_path).name,
        }

        return {"chunks": chunks, "metadata": metadata}
    finally:
        if tmp_file and os.path.exists(tmp_file):
            try:
                os.remove(tmp_file)
            except Exception:
                pass
        if conn:
            try:
                conn.close()
            except Exception:
                pass
