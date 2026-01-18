#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, sys, requests, mysql.connector
from pathlib import Path
from typing import Dict, Any, Optional

import pdfplumber
import docx2txt

# -------- env helpers ---------

def env(key: str, default: Optional[str] = None) -> Optional[str]:
    return os.environ.get(key, default)

def load_repo_env():
    try:
        repo_root = Path(__file__).resolve().parents[2]
    except Exception:
        repo_root = Path(os.getcwd())
    env_path = repo_root / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

load_repo_env()

DB_CONFIG = {
    "host": env("DB_HOST","localhost"),
    "port": int(env("DB_PORT","3306")),
    "user": env("DB_USER","root"),
    "password": env("DB_PASSWORD",env("DB_PASS","")),
    "database": env("DB_NAME","sqldb"),
    "autocommit": True,
}

def get_conn():
    return mysql.connector.connect(**DB_CONFIG)

# -------- text extraction ---------

def extract_text(file_path: Path) -> str:
    suffix = file_path.suffix.lower()

    if suffix == ".pdf":
        with pdfplumber.open(file_path) as pdf:
            return "\n".join(p.extract_text() or "" for p in pdf.pages)

    if suffix in {".docx",".doc"}:
        return docx2txt.process(str(file_path)) or ""

    return file_path.read_text(errors="ignore")

# -------- LLM ---------

def call_llm(text: str) -> Dict[str,Any]:
    key = env("OPENROUTER_API_KEY")
    if not key:
        return {"usp_points": [], "sequence": []}

    prompt = f"""
You are a pharmaceutical field-force auditing system evaluating MR doctor-detailing scripts.

The document is a sales detailing story used for doctor promotion.

Your task is to extract structured intelligence.

Return STRICT JSON only in the format below:

{{
  "usp_points": ["..."],
  "sequence": ["..."]
}}

USP extraction rules:
- Each USP must be one complete factual product claim.
- Always include the brand positioning statement
  (example: "presenting <brand> as ...") if present.
- Keep grouped claims grouped.
  Example: "100% RDA of antioxidants, amino acids, hemo-nutrients, and bone nutrients"
  must remain ONE USP — do NOT split.
- Preserve numeric values, units, dosages, quantities, and phrasing exactly.
- Preserve causal meaning such as "because", "ensuring", "helping".
- Do not infer, summarize, or add medical logic.

Sequence extraction rules:
- Extract the actual sales-story flow used in the script.
- Each entry must describe the section intent, not a heading.
  Examples:
  - "Problem statement on obesity and patient challenges"
  - "Brand introduction of Vidaslim"
  - "Nutritional composition and benefits"
  - "Trust and usage proof"
  - "Dosage and compliance explanation"
  - "Flavour options presentation"
  - "Closing with prescription call to action"

General rules:
- Extract only what is explicitly written.
- Maintain original ordering.
- No markdown, no explanations, JSON only.

SCRIPT:
\"\"\"
{text[:8000]}
\"\"\"
"""

    payload = {
        "model": env("OPENROUTER_MODEL","openai/gpt-4o-mini"),
        "messages":[{"role":"user","content": prompt}],
        "temperature": 0
    }

    r = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type":"application/json"},
        json=payload,
        timeout=60
    )

    content = r.json()["choices"][0]["message"]["content"]
    start = content.find("{")
    end = content.rfind("}") + 1
    return json.loads(content[start:end])
# -------- update ---------

def update_row(table:str, doc_id:int, text:str, usp:Dict[str,Any]):
    db = get_conn()
    cur = db.cursor()
    cur.execute(f"UPDATE `{table}` SET extracted_text=%s, usp_points=%s WHERE id=%s",
        (text, json.dumps(usp), doc_id))
    db.commit()
    cur.close()
    db.close()

# -------- main ---------

if __name__=="__main__":
    p = argparse.ArgumentParser()
    p.add_argument("table")
    p.add_argument("doc_id",type=int)
    p.add_argument("file_path")
    a = p.parse_args()

    text = extract_text(Path(a.file_path))
    usp = call_llm(text)
    update_row(a.table, a.doc_id, text[:65000], usp)
