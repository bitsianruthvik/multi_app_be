#!/usr/bin/env python3
"""
Embeddings + Pinecone upsert script for RAG chunks.

Usage examples:
    python embeddings_upsert.py --one company_documents 2 --dry-run
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import mysql.connector
from mysql.connector import pooling
import requests
import tempfile

try:
    import pdfplumber
except Exception:
    pdfplumber = None

from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

try:
    import google.generativeai as genai
except Exception:
    genai = None

# Try to load .env from repo root so environment variables in .env are respected when running
try:
    from dotenv import load_dotenv
    _DOTENV_AVAILABLE = True
except Exception:
    load_dotenv = None
    _DOTENV_AVAILABLE = False

LOG = logging.getLogger("embeddings_upsert")


def env(key: str, default: Optional[str] = None) -> Optional[str]:
    return os.environ.get(key, default)


def load_repo_env():
    """Load .env from repository root (role-based-auth/.env) if present.

    This ensures RAG_DATA_DIR and DB_* from .env are loaded into os.environ for local runs.
    """
    try:
        repo_root = Path(__file__).resolve().parents[2]
    except Exception:
        repo_root = Path(os.getcwd())
    env_path = repo_root / ".env"
    if env_path.exists():
        if _DOTENV_AVAILABLE:
            load_dotenv(dotenv_path=str(env_path), override=False)
            LOG.info("Loaded environment from %s", env_path)
        else:
            # Minimal .env parser fallback
            try:
                for line in env_path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip('\"').strip("\'")
                    if k not in os.environ:
                        os.environ[k] = v
                LOG.info("Loaded .env (fallback) from %s", env_path)
            except Exception:
                LOG.exception("Failed to read .env at %s", env_path)


# Load .env early
load_repo_env()


# DB config
DB_CONFIG = {
    "host": env("DB_HOST", "localhost"),
    "port": int(env("DB_PORT", "3306") or 3306),
    "user": env("DB_USER", "root"),
    "password": env("DB_PASSWORD", env("DB_PASS", "")),
    "database": env("DB_NAME", "sqldb"),
}


# RAG data dir default -- may be overridden by env or CLI
_env_rag = env("RAG_DATA_DIR")
_default_rag_candidate = (Path(__file__).resolve().parents[3] / "rag" / "data").resolve()
if _env_rag:
    RAG_DATA_DIR = _env_rag
else:
    # Prefer the repository-local rag/data if it exists; otherwise fall back to candidate path anyway
    if _default_rag_candidate.exists():
        RAG_DATA_DIR = str(_default_rag_candidate)
    else:
        RAG_DATA_DIR = str(_default_rag_candidate)

AUDIT_DIR = Path(env("AUDIT_DIR", os.path.join(os.getcwd(), "rag_audit")))
BATCH_EMBED = int(env("BATCH_EMBED", "16"))
PINECONE_BATCH = int(env("PINECONE_BATCH", "50"))

GEMINI_API_KEY = env("GEMINI_API_KEY")
PINECONE_API_KEY = env("PINECONE_API_KEY")
PINECONE_INDEX_NAME = env("PINECONE_INDEX_NAME")
PINECONE_ENV = env("PINECONE_ENV")

POOL: Optional[pooling.MySQLConnectionPool] = None


def init_db_pool(pool_name: str = "emb_pool", pool_size: int = 5):
    global POOL
    if POOL is None:
        POOL = pooling.MySQLConnectionPool(pool_name=pool_name, pool_size=pool_size, **DB_CONFIG)
    return POOL


def get_conn():
    if POOL is None:
        init_db_pool()
    return POOL.get_connection()


def fetch_doc_metadata(table: str, doc_id: int) -> Dict[str, Any]:
    """Fetch business metadata for a document from DB.

    Returns dict with keys: company_id, team_id, doc_path, doc_name (if present).
    If row is missing, returns {}. Handles unknown columns gracefully.
    """
    conn = None
    cur = None
    out: Dict[str, Any] = {}
    try:
        conn = get_conn()
        cur = conn.cursor(dictionary=True)
        # Attempt to select likely columns; unknown columns will be ignored by MySQL if not present in SELECT list
        # However, to be safe, we select broadly and then read what exists in the row.
        try:
            cur.execute(f"SELECT id, company_id, team_id, doc_path, doc_name FROM `{table}` WHERE id = %s", (doc_id,))
        except Exception:
            # Fallback select without doc_name/team_id
            LOG.warning("Metadata select failed for %s; retrying with reduced column set", table)
            try:
                cur.execute(f"SELECT id, company_id, doc_path FROM `{table}` WHERE id = %s", (doc_id,))
            except Exception:
                LOG.exception("Metadata select failed for %s id=%s", table, doc_id)
                return {}

        row = cur.fetchone()
        if not row:
            return {}

        out["company_id"] = row.get("company_id")
        out["team_id"] = row.get("team_id")
        out["doc_path"] = row.get("doc_path")
        # Derive doc_name: prefer DB column, else basename of doc_path
        doc_name = row.get("doc_name")
        if not doc_name:
            try:
                if out.get("doc_path"):
                    doc_name = Path(out["doc_path"]).name
            except Exception:
                doc_name = None
        out["doc_name"] = doc_name
        return out
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


def column_exists(conn: mysql.connector.MySQLConnection, table: str, column: str) -> bool:
    cur = conn.cursor()
    try:
        cur.execute("SHOW COLUMNS FROM `{}` LIKE %s".format(table), (column,))
        rows = cur.fetchall()
        return len(rows) > 0
    finally:
        cur.close()


def mark_vectors_ingested(conn: mysql.connector.MySQLConnection, table: str, row_id: int, success: bool):
    if not column_exists(conn, table, "vectors_ingested"):
        LOG.debug("Column 'vectors_ingested' does not exist on %s; skipping mark", table)
        return
    cur = conn.cursor()
    try:
        val = 1 if success else 2
        cur.execute(f"UPDATE `{table}` SET vectors_ingested = %s WHERE id = %s", (val, row_id))
        conn.commit()
    finally:
        cur.close()


# NOTE: directory-based chunk processing and RAG_DATA_DIR are removed.
# The new flow embeds and upserts in-memory chunks provided by `ingest_in_memory()`.


def setup_genai():
    if genai is None:
        raise RuntimeError("google.generativeai package not installed")
    # Accept GEMINI_API_KEY or GOOGLE_API_KEY, otherwise rely on application default credentials
    key = GEMINI_API_KEY or env("GOOGLE_API_KEY")
    if key:
        try:
            genai.configure(api_key=key)
            LOG.info("Configured genai with provided API key (masked=%s)", mask_key(key))
        except Exception:
            LOG.debug("genai.configure failed; relying on application credentials or env")
    else:
        if env("GOOGLE_APPLICATION_CREDENTIALS"):
            LOG.info("Using GOOGLE_APPLICATION_CREDENTIALS for genai authentication")
        else:
            LOG.info("No genai key provided; will attempt to use application default credentials")


def mask_key(k: Optional[str]) -> str:
    if not k:
        return "<missing>"
    s = str(k)
    if len(s) <= 8:
        return s[0:2] + ".." + s[-2:]
    return s[0:4] + ".." + s[-2:]


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=5),
       retry=retry_if_exception_type(Exception))
def embed_texts(texts: List[str]) -> List[List[float]]:
    if genai is None:
        raise RuntimeError("google.generativeai not available")
    if not texts:
        return []

    # Resolve model: prefer env EMBEDDING_MODEL, else gemini-embedding-001
    model = env("EMBEDDING_MODEL") or "gemini-embedding-001"

    def extract_vector(resp_obj: Any) -> Optional[List[float]]:
        """Extract embedding vector from various possible response shapes."""
        try:
            # dict shapes
            if isinstance(resp_obj, dict):
                # {"embedding": {"values": [...]}}
                if "embedding" in resp_obj:
                    emb = resp_obj["embedding"]
                    if isinstance(emb, dict) and "values" in emb:
                        return list(emb["values"])  # type: ignore
                    if isinstance(emb, list):
                        return list(emb)
                # {"embeddings": [{"values": [...]}]}
                if "embeddings" in resp_obj and isinstance(resp_obj["embeddings"], list):
                    first = resp_obj["embeddings"][0] if resp_obj["embeddings"] else None
                    if isinstance(first, dict) and "values" in first:
                        return list(first["values"])  # type: ignore
            # object with attributes
            if hasattr(resp_obj, "embedding"):
                emb_attr = getattr(resp_obj, "embedding")
                # `resp.embedding.values`
                if hasattr(emb_attr, "values"):
                    return list(getattr(emb_attr, "values"))  # type: ignore
                if isinstance(emb_attr, list):
                    return list(emb_attr)
            # sometimes response is directly the vector
            if isinstance(resp_obj, list):
                # assume it's the vector
                return list(resp_obj)
        except Exception:
            return None
        return None

    embeddings: List[List[float]] = []
    for i, text in enumerate(texts):
        try:
            if hasattr(genai, "embed_content"):
                resp = genai.embed_content(model=model, content=text)
            elif hasattr(genai, "embed_content_async"):
                fut = genai.embed_content_async(model=model, content=text)
                resp = fut.result() if hasattr(fut, "result") else fut
            else:
                raise RuntimeError("genai.embed_content not available in installed package")

            vec = extract_vector(resp)
            if not vec:
                # Some SDK versions return dict with top-level 'embedding' or 'embeddings'
                vec = extract_vector(getattr(resp, "result", None))
            if not vec:
                raise RuntimeError("Embedding API produced no embeddings for one of the texts")
            embeddings.append(vec)
        except Exception as e:
            LOG.error("Embedding failed for item %d: %s", i, repr(e))
            raise

    if len(embeddings) != len(texts):
        raise RuntimeError("Embedding count mismatch")

    return embeddings


def setup_pinecone() -> Any:
    if not PINECONE_API_KEY or not PINECONE_INDEX_NAME:
        raise RuntimeError("Pinecone requires PINECONE_API_KEY and PINECONE_INDEX_NAME environment variables")

    try:
        import pinecone as pc
        LOG.info("Imported pinecone")
    except Exception:
        try:
            import pinecone_client as pc
            LOG.info("Imported pinecone_client")
        except Exception:
            pc = None

    if pc is None:
        raise RuntimeError("Pinecone client not found. Install with: pip install pinecone")

    try:
        if hasattr(pc, "init") and hasattr(pc, "Index"):
            try:
                pc.init(api_key=PINECONE_API_KEY, environment=PINECONE_ENV or "")
            except TypeError:
                pc.init(api_key=PINECONE_API_KEY)
            return pc.Index(PINECONE_INDEX_NAME)
        elif hasattr(pc, "Pinecone"):
            client = pc.Pinecone(api_key=PINECONE_API_KEY)
            return client.Index(PINECONE_INDEX_NAME)
        elif hasattr(pc, "Index"):
            return pc.Index(PINECONE_INDEX_NAME)
    except Exception as e:
        LOG.exception("Failed to initialize Pinecone: %s", e)
        raise


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=5),
       retry=retry_if_exception_type(Exception))
def pinecone_upsert(index, vectors: List[Tuple[str, List[float], Dict[str, Any]]]):
    if not vectors:
        return None
    return index.upsert(vectors=vectors)


def embed_and_upsert(chunks: List[str], metadata: Dict[str, Any], dry_run: bool = False, index: Optional[Any] = None) -> Dict[str, Any]:
    """Embed given chunks and upsert directly to Pinecone.

    - chunks: list of chunk strings
    - metadata: dict containing at least table and doc_id and company/team info
    - dry_run: if True, does not perform Pinecone upsert
    - index: optional Pinecone index object; if None and not dry_run, will be created

    Returns an audit dict with counts.
    """
    table = metadata.get("table")
    doc_id = int(metadata.get("doc_id"))

    # Safety: if chunks appear to contain raw PDF binary (starts with %PDF-)
    # or if the source is a PDF file, re-extract text from the original PDF
    def looks_like_pdf_content(text: str) -> bool:
        try:
            s = text.strip()
            return s.startswith("%PDF-") or "%PDF-" in s[:64]
        except Exception:
            return False

    try:
        # If any chunk looks like PDF binary, or metadata.doc_name endswith .pdf, attempt to extract text
        doc_name = metadata.get("doc_name") or ""
        pdf_hint = False
        if isinstance(doc_name, str) and doc_name.lower().endswith(".pdf"):
            pdf_hint = True
        if any(looks_like_pdf_content(c) for c in chunks):
            pdf_hint = True

        if pdf_hint:
            # Obtain doc_path from DB to read the real file
            try:
                meta_row = fetch_doc_metadata(table, doc_id)
                doc_path = meta_row.get("doc_path")
            except Exception:
                doc_path = None

            if not doc_path:
                raise ValueError("PDF detected but doc_path unavailable for extraction")

            # Download if remote, else read local
            tmp_file = None
            try:
                if doc_path.startswith("http://") or doc_path.startswith("https://"):
                    if not pdfplumber:
                        raise RuntimeError("pdfplumber not installed")
                    resp = requests.get(doc_path, timeout=30)
                    resp.raise_for_status()
                    fd, tmp_file = tempfile.mkstemp(suffix=".pdf")
                    os.close(fd)
                    with open(tmp_file, "wb") as f:
                        f.write(resp.content)
                    source_pdf = tmp_file
                else:
                    # local path may be absolute or a URL-like path; try to resolve
                    source_pdf = str(Path(doc_path))
                    if not Path(source_pdf).exists():
                        # try resolving relative to repo
                        candidate = Path(__file__).resolve().parents[3] / Path(doc_path).name
                        if candidate.exists():
                            source_pdf = str(candidate)

                if not pdfplumber:
                    raise RuntimeError("pdfplumber not installed; cannot extract PDF text")

                texts: List[str] = []
                with pdfplumber.open(source_pdf) as pdf:
                    for p in pdf.pages:
                        t = p.extract_text()
                        if t:
                            texts.append(t)

                full_text = "\n".join(texts).strip()
                if not full_text or not full_text.strip():
                    raise ValueError("PDF text extraction failed — refusing to embed raw PDF")

                # Simple chunker: whitespace words into CHUNK_SIZE words (approx)
                import re

                words = re.findall(r"\S+", full_text)
                if not words:
                    raise ValueError("PDF text extraction returned no words")
                CHUNK_SIZE = int(env("CHUNK_SIZE", "350"))
                CHUNK_OVERLAP = int(env("CHUNK_OVERLAP", "50"))
                step = max(1, CHUNK_SIZE - CHUNK_OVERLAP)
                new_chunks: List[str] = []
                for i in range(0, len(words), step):
                    piece = words[i : i + CHUNK_SIZE]
                    new_chunks.append(" ".join(piece))
                    if i + CHUNK_SIZE >= len(words):
                        break

                chunks = new_chunks

            finally:
                try:
                    if tmp_file and os.path.exists(tmp_file):
                        os.remove(tmp_file)
                except Exception:
                    pass
    except Exception:
        LOG.exception("PDF extraction/repair failed for %s/%s", table, doc_id)
        raise

    # Prepare embedding batches
    all_embeddings: List[List[float]] = []
    for i in range(0, len(chunks), BATCH_EMBED):
        j = min(i + BATCH_EMBED, len(chunks))
        LOG.info("Embedding batch %d-%d for %s_%s", i, j - 1, table, doc_id)
        batch = chunks[i:j]
        emb = embed_texts(batch)
        all_embeddings.extend(emb)

    if len(all_embeddings) != len(chunks):
        raise RuntimeError("Embedding count mismatch")

    # Resolve company/team and doc_name
    company_id = metadata.get("company_id")
    team_id = metadata.get("team_id")
    doc_name = metadata.get("doc_name")

    vectors: List[Tuple[str, List[float], Dict[str, Any]]] = []
    for idx, (chunk_text, vec) in enumerate(zip(chunks, all_embeddings)):
        vid = f"{table}_{doc_id}_c{idx}"
        try:
            max_len = 1200
            truncated_chunk_text = chunk_text if len(chunk_text) <= max_len else (chunk_text[:max_len] + "...")
        except Exception:
            truncated_chunk_text = chunk_text

        meta = {
            "table": table,
            "doc_id": doc_id,
            "chunk_index": idx,
            "doc_name": str(doc_name or ""),
            "chunk_text": str(truncated_chunk_text or ""),
        }
        if company_id is not None:
            try:
                meta["company_id"] = int(company_id)
            except Exception:
                meta["company_id"] = str(company_id)
        if team_id is not None:
            try:
                meta["team_id"] = int(team_id)
            except Exception:
                meta["team_id"] = str(team_id)

        vectors.append((vid, vec, meta))

    # Upsert
    vectors_upserted = 0
    if dry_run:
        LOG.info("Dry-run: would upsert %d vectors for %s_%s", len(vectors), table, doc_id)
    else:
        if index is None:
            index = setup_pinecone()
        for k in range(0, len(vectors), PINECONE_BATCH):
            chunk = vectors[k : k + PINECONE_BATCH]
            pinecone_upsert(index, chunk)
            vectors_upserted += len(chunk)

    audit = {
        "table": table,
        "doc_id": doc_id,
        "vectors_prepared": len(vectors),
        "vectors_upserted": 0 if dry_run else vectors_upserted,
        "timestamp": int(time.time()),
    }

    # Optionally mark DB
    if not dry_run:
        try:
            conn = get_conn()
            mark_vectors_ingested(conn, table, doc_id, success=True)
            conn.close()
        except Exception:
            LOG.exception("Failed to mark DB for %s_%s", table, doc_id)

    return {"doc_table": table, "doc_id": doc_id, "vectors_upserted": 0 if dry_run else vectors_upserted, "audit": audit}


def orchestrate_ingest_and_upsert(table: str, doc_id: int, dry_run: bool = False) -> Dict[str, Any]:
    """Orchestrate: ingest in-memory then embed and upsert to Pinecone.

    This is the single in-process flow for a freshly-inserted document.
    """
    # Import here to avoid circular import at module import time
    try:
        from .ingest_documents import ingest_in_memory
    except Exception:
        # fallback for direct script import path
        from ingest_documents import ingest_in_memory

    res = ingest_in_memory(table, doc_id)
    chunks = res.get("chunks", [])
    metadata = res.get("metadata", {})
    if not chunks:
        LOG.info("No chunks produced for %s/%s", table, doc_id)
        return {"doc_table": table, "doc_id": doc_id, "vectors_upserted": 0, "audit": {}}

    # perform embedding + upsert
    return embed_and_upsert(chunks, metadata, dry_run=dry_run)


def ensure_audit_dir():
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    return AUDIT_DIR



def describe_index_count(index) -> Optional[int]:
    if index is None:
        return None
    try:
        stats = index.describe_index_stats()
        if isinstance(stats, dict) and "total_vector_count" in stats:
            return int(stats.get("total_vector_count", 0))
        if isinstance(stats, dict) and "namespaces" in stats:
            total = 0
            for ns, info in stats.get("namespaces", {}).items():
                total += int(info.get("vector_count", 0))
            return total
    except Exception:
        LOG.exception("Failed to describe index stats")
    return None


def main():
    parser = argparse.ArgumentParser(description="Embed chunks and upsert to Pinecone")
    parser.add_argument("--one", nargs=2, metavar=("TABLE", "ID"), help="Process a single document")
    parser.add_argument("--rag-data", dest="rag_data", help="Override RAG_DATA_DIR (path to rag/data)")
    parser.add_argument("--loop", action="store_true", help="Run in loop mode")
    parser.add_argument("--interval", type=int, default=60, help="Loop interval seconds")
    parser.add_argument("--dry-run", action="store_true", help="Do not upsert to Pinecone")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    LOG.setLevel(logging.INFO)

    # validate DB credentials early and fail with clear message if missing
    missing_db = []
    if not env("DB_USER"):
        missing_db.append("DB_USER")
    if not (env("DB_PASSWORD") or env("DB_PASS")):
        missing_db.append("DB_PASSWORD")
    if missing_db:
        LOG.error("Missing required DB environment variables: %s. Please set them in your environment or the .env file.", ",".join(missing_db))
        raise SystemExit(2)

    # Note: RAG_DATA_DIR/directory-based processing removed.
    if args.rag_data:
        LOG.info("--rag-data provided but ignored in in-memory flow: %s", args.rag_data)

    init_db_pool()
    setup_genai()

    index = None
    if not args.dry_run:
        index = setup_pinecone()

    before = describe_index_count(index)
    LOG.info("Pinecone index count before: %s", before)

    def run_once():
        results = []
        if args.one:
            table, sid = args.one
            LOG.info("Processing single %s/%s via in-memory flow", table, sid)
            res = orchestrate_ingest_and_upsert(table, int(sid), dry_run=args.dry_run)
            results.append(res)
        else:
            LOG.info("Batch/pending processing removed in favor of event-driven ingestion. No-op when no --one provided.")
        return results

    try:
        if args.loop:
            while True:
                run_once()
                time.sleep(args.interval)
        else:
            results = run_once()
    except KeyboardInterrupt:
        LOG.info("Interrupted by user")
        results = []

    after = describe_index_count(index)
    LOG.info("Pinecone index count after: %s", after)
    LOG.info("Run results: %s", json.dumps(results if results is not None else {}, default=str, indent=2))


if __name__ == "__main__":
    main()
