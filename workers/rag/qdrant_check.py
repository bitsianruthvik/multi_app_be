# qdrant_check.py
import os
import json
import requests
from pprint import pprint
from qdrant_client import QdrantClient

# adjust if different
QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
COLLECTION = os.environ.get("QDRANT_COLLECTION", "rag_chunks")
EMBEDDING_DIM = int(os.environ.get("EMBEDDING_DIM", "3072"))

# import your embedding helper (same one used by upsert)
try:
    from embeddings_upsert import load_repo_env, setup_genai, embed_texts
except Exception:
    # fallback if embedding helper not available
    embed_texts = None

def http_search(query_vector, collection=COLLECTION, topk=5, filter_obj=None):
    """
    Use Qdrant REST API to run a vector search. This is compatible with all Qdrant versions.
    filter_obj should be a dict representing the JSON 'filter' body if you want to filter by payload.
    """
    url = f"{QDRANT_URL}/collections/{collection}/points/search"
    body = {
        "vector": query_vector,
        "limit": topk
    }
    if filter_obj is not None:
        body["filter"] = filter_obj
    resp = requests.post(url, json=body)
    resp.raise_for_status()
    return resp.json()

def main():
    print("Qdrant URL:", QDRANT_URL)
    client = QdrantClient(url=QDRANT_URL)

    # 1) collection info
    info = client.get_collection(COLLECTION)
    print("Collection info (summary):")
    pprint({
        "points_count": getattr(info, "points_count", getattr(info, "vectors_count", None)),
        "vector_size": info.config.params.vectors.size if info and info.config and info.config.params and info.config.params.vectors else None,
        "distance": getattr(info.config.params.vectors, "distance", None) if info and info.config and info.config.params and info.config.params.vectors else None,
    })

    # 2) scroll a few points
    print("\nFirst few points (scroll):")
    scroll = client.scroll(collection_name=COLLECTION, limit=5)
    pprint(scroll)

    # 3) semantic search by embedding (use your embed_texts)
    if embed_texts is None:
        print("\nembed_texts not available; skipping semantic query test. Install/enable it to run embedding-based queries.")
        return

    # Ensure SDK configured
    try:
        load_repo_env()
        setup_genai()
    except Exception:
        pass

    query_text = "What is the dosing schedule for Oncaryva?"
    print("\nGenerating embedding for query:", query_text)
    qvecs = embed_texts([query_text])
    if not qvecs or not isinstance(qvecs, list):
        print("embed_texts did not return embedding list; aborting.")
        return
    qvec = qvecs[0]
    print("embedding length:", len(qvec))

    # 4) run REST search
    print("\nRunning REST vector search (top 5):")
    results_json = http_search(query_vector=qvec, topk=5)
    pprint(results_json)

    # 5) example: filter by legacy_id
    legacy_id = "company_documents_2_c0"
    print(f"\nSearching for payload.legacy_id == {legacy_id}")
    filter_obj = {"must": [{"key": "legacy_id", "match": {"value": legacy_id}}]}
    filtered = http_search(query_vector=qvec, topk=5, filter_obj=filter_obj)
    pprint(filtered)

if __name__ == "__main__":
    main()
