#!/usr/bin/env python3
"""
Embeddings + Qdrant upsert script for RAG chunks.

This is a standalone alternative to embeddings_upsert.py that writes vectors to
local Qdrant (self-hosted) instead of Pinecone.

Usage examples:
    python embeddings_upsert_qdrant.py --one company_documents 2 --dry-run
    python embeddings_upsert_qdrant.py --loop --interval 60
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# reuse DB, embedding, and chunk helpers from your existing module
# (we import functions only; embedding code lives in embeddings_upsert.py)
try:
    from embeddings_upsert import (
        load_repo_env,
        init_db_pool,
        get_conn,
        fetch_doc_metadata,
        list_pending_docs,
        read_chunk_files,
        setup_genai,
        embed_texts,
        mark_vectors_ingested,
        AUDIT_DIR,
        BATCH_EMBED,
        RAG_DATA_DIR,
    )
except Exception as e:
    raise RuntimeError(
        "Failed to import helper functions from embeddings_upsert.py. "
        "Ensure embeddings_upsert.py is in the same folder and has the expected functions."
    ) from e

# Qdrant client
from qdrant_client import QdrantClient
from qdrant_client.models import VectorParams, PointStruct, Distance
from qdrant_client.http.exceptions import UnexpectedResponse

LOG = logging.getLogger("embeddings_upsert_qdrant")

# Config & defaults (override from env)
QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
QDRANT_COLLECTION = os.environ.get("QDRANT_COLLECTION", "rag_chunks")
EMBEDDING_DIM = int(os.environ.get("EMBEDDING_DIM", "1536"))
QDRANT_BATCH = int(os.environ.get("QDRANT_BATCH", "100"))

# Fallbacks if imported values missing
if "BATCH_EMBED" not in globals() or BATCH_EMBED is None:
    BATCH_EMBED = int(os.environ.get("BATCH_EMBED", "16"))

if "AUDIT_DIR" not in globals() or AUDIT_DIR is None:
    AUDIT_DIR = Path(os.environ.get("AUDIT_DIR", "./rag_audit"))
if isinstance(AUDIT_DIR, str):
    AUDIT_DIR = Path(AUDIT_DIR)

if "RAG_DATA_DIR" not in globals() or RAG_DATA_DIR is None:
    RAG_DATA_DIR = os.environ.get("RAG_DATA_DIR", "./rag/data")

# Qdrant client singleton
_qdrant_client: Optional[QdrantClient] = None


def get_qdrant_client() -> QdrantClient:
    global _qdrant_client
    if _qdrant_client is None:
        _qdrant_client = QdrantClient(url=QDRANT_URL)
    return _qdrant_client


def ensure_qdrant_collection(collection: str = QDRANT_COLLECTION, dim: int = EMBEDDING_DIM) -> None:
    """
    Create collection if not exists. Reuses same defaults as Pinecone mapping.
    """
    client = get_qdrant_client()
    existing = [c.name for c in client.get_collections().collections]
    if collection not in existing:
        LOG.info("Creating Qdrant collection '%s' (dim=%s)", collection, dim)
        client.create_collection(
            collection_name=collection,
            vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
        )
    else:
        LOG.debug("Qdrant collection '%s' already exists", collection)


def qdrant_upsert(
    client: QdrantClient,
    points: List[Tuple[str, List[float], Dict[str, Any]]],
    collection_name: Optional[str] = None,
):
    """
    Upsert a list of tuples: (id, vector, metadata)
    This wraps client.upsert and logs any UnexpectedResponse with server body.
    """
    if collection_name is None:
        collection_name = QDRANT_COLLECTION
    if not points:
        return
    qpoints = [PointStruct(id=pid, vector=vec, payload=meta) for (pid, vec, meta) in points]
    try:
        client.upsert(collection_name=collection_name, points=qpoints)
    except UnexpectedResponse as e:
        LOG.error("Qdrant upsert failed with UnexpectedResponse: %s", e)
        # attempt to extract response body / status if present
        try:
            resp = getattr(e, "response", None)
            if resp is not None:
                # resp may be a requests.Response-like object or a custom wrapper
                try:
                    status = getattr(resp, "status_code", None)
                    text = getattr(resp, "text", None)
                    LOG.error("Server response status=%s body=%s", status, text)
                except Exception:
                    LOG.exception("Failed to log raw response from UnexpectedResponse")
        except Exception:
            LOG.exception("Error while handling UnexpectedResponse")
        raise


def describe_collection_count(client: QdrantClient, collection_name: Optional[str] = None) -> Optional[int]:
    if collection_name is None:
        collection_name = QDRANT_COLLECTION
    try:
        info = client.get_collection(collection_name)
        # depending on qdrant-client version, attribute may be `vectors_count` or `points_count`
        cnt = getattr(info, "vectors_count", None)
        if cnt is None:
            cnt = getattr(info, "points_count", None)
        return int(cnt) if cnt is not None else None
    except Exception:
        LOG.exception("Failed to get collection info for %s", collection_name)
        return None


def ensure_audit_dir() -> Path:
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    return AUDIT_DIR


def process_one_dir_qdrant(
    qclient: QdrantClient,
    table: str,
    doc_id: Any,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """
    Equivalent to process_one_dir in embeddings_upsert.py but writes to Qdrant.
    """
    doc_dir = Path(RAG_DATA_DIR) / table / str(doc_id)
    LOG.info("Processing doc_dir=%s", doc_dir)
    if not doc_dir.exists() or not doc_dir.is_dir():
        LOG.error("Missing doc_dir: %s", doc_dir)
        return {"skipped": True, "reason": "not_dir"}

    try:
        int_doc_id = int(doc_id)
    except Exception:
        int_doc_id = doc_id

    chunks = read_chunk_files(doc_dir)
    if not chunks:
        LOG.info("No chunks for %s/%s", table, doc_id)
        return {"skipped": True, "reason": "no_chunks"}

    # Keep same ordering used elsewhere
    chunks = sorted(chunks, key=lambda t: t[0])
    texts = [t[1] for t in chunks]

    # Fetch DB metadata for this document
    db_meta: Dict[str, Any] = {}
    try:
        db_meta = fetch_doc_metadata(table, int_doc_id)
    except Exception:
        LOG.exception("Failed to fetch DB metadata for %s/%s", table, int_doc_id)
        db_meta = {}

    company_id = db_meta.get("company_id")
    team_id = db_meta.get("team_id")
    doc_name = db_meta.get("doc_name")

    # embedding batches using existing embed_texts
    all_embeddings: List[List[float]] = []
    for i in range(0, len(texts), BATCH_EMBED):
        j = min(i + BATCH_EMBED, len(texts))
        LOG.info("Embedding batch %d-%d for %s_%s", i, j - 1, table, doc_id)
        batch = texts[i:j]
        emb = embed_texts(batch)
        all_embeddings.extend(emb)

    if len(all_embeddings) != len(texts):
        raise RuntimeError("Embedding count mismatch")

    # Build vectors in same format used by previous script
    vectors: List[Tuple[str, List[float], Dict[str, Any]]] = []
    for (chunk_idx, _text, path), vec in zip(chunks, all_embeddings):
        # Build stable legacy id and deterministic UUID for Qdrant point id
        legacy_id_str = f"{table}_{int_doc_id}_c{chunk_idx}"
        vid_uuid = uuid.uuid5(uuid.NAMESPACE_URL, legacy_id_str)
        vid = str(vid_uuid)  # valid UUID string accepted by Qdrant

        try:
            max_len = 1200
            truncated_chunk_text = _text if len(_text) <= max_len else (_text[:max_len] + "...")
        except Exception:
            truncated_chunk_text = _text

        effective_doc_name = doc_name or path.name

        meta: Dict[str, Any] = {
            "table": table,
            "doc_id": int_doc_id,
            "chunk_index": chunk_idx,
            "source_path": path.name,
            "doc_name": str(effective_doc_name or path.name),
            "chunk_text": str(truncated_chunk_text or ""),
            # include the legacy readable id for traceability
            "legacy_id": legacy_id_str,
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

    ensure_audit_dir()

    vectors_upserted = 0
    if dry_run:
        LOG.info("Dry-run: would upsert %d vectors for %s_%s", len(vectors), table, doc_id)
    else:
        if qclient is None:
            raise RuntimeError("Qdrant client not initialized")
        # Upsert in batches
        for k in range(0, len(vectors), QDRANT_BATCH):
            chunk = vectors[k : k + QDRANT_BATCH]
            qdrant_upsert(qclient, chunk, collection_name=QDRANT_COLLECTION)
            vectors_upserted += len(chunk)

    # Write audit file
    audit = {
        "table": table,
        "doc_id": int_doc_id,
        "vectors_prepared": len(vectors),
        "vectors_upserted": 0 if dry_run else vectors_upserted,
        "timestamp": int(time.time()),
    }
    audit_file = AUDIT_DIR / f"{table}_{int_doc_id}.json"
    audit_file.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")

    if not dry_run:
        try:
            conn = get_conn()
            mark_vectors_ingested(conn, table, int_doc_id, success=True)
            conn.close()
        except Exception:
            LOG.exception("Failed to mark DB for %s_%s", table, int_doc_id)

    return {"doc_table": table, "doc_id": int_doc_id, "vectors_upserted": 0 if dry_run else vectors_upserted, "audit": str(audit_file)}


def main():
    parser = argparse.ArgumentParser(description="Embed chunks and upsert to Qdrant")
    parser.add_argument("--one", nargs=2, metavar=("TABLE", "ID"), help="Process a single document")
    parser.add_argument("--rag-data", dest="rag_data", help="Override RAG_DATA_DIR (path to rag/data)")
    parser.add_argument("--loop", action="store_true", help="Run in loop mode")
    parser.add_argument("--interval", type=int, default=60, help="Loop interval seconds")
    parser.add_argument("--dry-run", action="store_true", help="Do not upsert to Qdrant")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    LOG.setLevel(logging.INFO)

    # Load env from repo (same helper used originally)
    load_repo_env()

    # allow CLI override for RAG_DATA_DIR
    global RAG_DATA_DIR
    if args.rag_data:
        LOG.info("Overriding RAG_DATA_DIR from CLI to %s", args.rag_data)
        RAG_DATA_DIR = args.rag_data
    LOG.info("Resolved RAG_DATA_DIR=%s", RAG_DATA_DIR)

    # init DB pool and GenAI SDK
    init_db_pool()
    setup_genai()

    qclient = None
    if not args.dry_run:
        qclient = get_qdrant_client()
        ensure_qdrant_collection(QDRANT_COLLECTION, EMBEDDING_DIM)

    before = describe_collection_count(qclient, QDRANT_COLLECTION) if qclient else None
    LOG.info("Qdrant vector count before: %s", before)

    def run_once():
        results = []
        if args.one:
            table, sid = args.one
            res = process_one_dir_qdrant(qclient, table, sid, dry_run=args.dry_run)
            results.append(res)
        else:
            pending = list_pending_docs()
            if not pending:
                LOG.info("No pending documents to embed")
            else:
                for table, sid in pending:
                    LOG.info("Processing pending %s/%s", table, sid)
                    res = process_one_dir_qdrant(qclient, table, sid, dry_run=args.dry_run)
                    results.append(res)
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

    after = describe_collection_count(qclient, QDRANT_COLLECTION) if qclient else None
    LOG.info("Qdrant vector count after: %s", after)
    LOG.info("Run results: %s", json.dumps(results if results is not None else {}, default=str, indent=2))


if __name__ == "__main__":
    main()
