"""Transcript analysis service with async enqueue support.

This module provides:
- /api/analyze_by_id -> synchronous analyze and update
- /api/analyze_inline -> analyze supplied transcription text
- /api/analyze_by_id_async -> enqueue job and return job_id
- /api/analysis_status -> poll job state

It uses an in-memory queue and a worker thread (no external deps).
"""

print("RUNNING ANALYSIS_SERVICE — NO RETRY — VERIFIED")

import os
import json
import logging
import time
from typing import Optional, Dict, Any
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
from openai import OpenAI
import mysql.connector
from mysql.connector import pooling
import threading
import queue
import uuid

load_dotenv()  # loads .env in project root if present

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.2")

API_TIMEOUT = int(os.getenv("LLM_TIMEOUT_SECONDS", "45"))
MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "3500"))

DB_HOST = os.getenv("DB_HOST", "localhost")
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_NAME = os.getenv("DB_NAME", "sqldb")
DB_POOL_NAME = "mypool"
DB_POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "5"))

# -------- Brand Guide to provide domain context to the LLM ----------
# The brand guide below will be provided to the model as additional context.

# -------- Logging ----------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("analysis-service")

# Fail fast if critical env missing
if not OPENAI_API_KEY:
    logger.error(
        "Missing OPENAI_API_KEY. Set it before starting. Example (PowerShell): $env:OPENAI_API_KEY='your_key_here' or setx OPENAI_API_KEY \"your_key_here\""
    )
    raise SystemExit("OPENAI_API_KEY not set")

# Initialize OpenAI client
client = OpenAI(api_key=OPENAI_API_KEY)

# -------- DB pool ----------
try:
    POOL = pooling.MySQLConnectionPool(
        pool_name=DB_POOL_NAME,
        pool_size=DB_POOL_SIZE,
        host=DB_HOST,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_NAME,
        auth_plugin="mysql_native_password",
    )
    logger.info("DB pool created.")
except Exception as e:
    logger.exception("Failed to create DB pool: %s", e)
    POOL = None

# -------- FastAPI ----------
app = FastAPI(title="Transcript Analysis Service")


class AnalyzeByIdRequest(BaseModel):
    id: int
    medicine: str
    # optional: override model
    model: Optional[str] = None


class AnalyzeInlineRequest(BaseModel):
    transcription: str
    medicine: str
    model: Optional[str] = None


# -------- Helper functions for document retrieval ----------
def get_db_conn():
    if not POOL:
        raise RuntimeError("DB pool not initialized")
    return POOL.get_connection()


def fetch_previous_calls_for_llm_context(row_id: int):
    """Fetch previous call data to provide LLM with context during call analysis.
    
    NOTE: This is NOT history analysis. It provides context to the LLM prompt.
    See /api/history_analysis for actual history-level analysis.
    
    Args:
        row_id: Current call ID (excluded from results)
    
    Returns:
        List of previous call track data for LLM context
    """
    conn = get_db_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("""
            SELECT track FROM audio_recordings
            WHERE id != %s AND track IS NOT NULL
            ORDER BY updated_at DESC
            LIMIT 5
        """, (row_id,))
        rows = cur.fetchall()
        cur.close()

        context_data = []
        for r in rows:
            raw = r.get("track")
            if not raw:
                continue
            try:
                context_data.append(json.loads(raw))
            except Exception:
                logger.warning("Skipping corrupt track data: %s", str(raw)[:120])
        return context_data
    finally:
        conn.close()


def get_brand_guide_from_db(medicine: str) -> Optional[dict]:
    """Retrieve extracted_text and usp_points from team_documents for given medicine.
    
    Args:
        medicine: Medicine name to search for
    
    Returns:
        dict with 'extracted_text' and 'usp_points' keys, or None if not found
    """
    conn = get_db_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("""
            SELECT extracted_text, usp_points
            FROM team_documents
            WHERE LOWER(medicines) = LOWER(%s)
            ORDER BY uploaded_at DESC
            LIMIT 1
        """, (medicine.strip(),))
        row = cur.fetchone()
        cur.close()
        return row
    finally:
        conn.close()


def call_chatgpt(prompt: str, timeout: int = API_TIMEOUT, model: Optional[str] = None) -> str:
    """Call OpenAI GPT-5.2 with strict JSON enforcement.
    
    Args:
        prompt: User prompt for the LLM
        timeout: Timeout in seconds
        model: Optional model override (defaults to OPENAI_MODEL)
    
    Returns:
        JSON string from LLM
    
    Raises:
        RuntimeError: If rate limited or API error
    """
    try:
        response = client.chat.completions.create(
            model=model if model else OPENAI_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": "You must return ONLY valid JSON. No markdown. No code blocks. No explanations. No text outside JSON structure. Return pure JSON only."
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            temperature=0.15,
            max_tokens=MAX_TOKENS,
            response_format={"type": "json_object"},
            timeout=timeout
        )
        
        return response.choices[0].message.content
        
    except Exception as e:
        error_str = str(e)
        if "rate_limit" in error_str.lower() or "429" in error_str:
            raise RuntimeError("OPENAI_RATE_LIMITED")
        raise


def build_prompt(transcription: str, brand_guide: str, medicine: str, usp_points: str) -> str:
    return f"""
**SYSTEM INSTRUCTION (Give this to the LLM):**

You are an expert MR–doctor interaction auditor.
You evaluate Medical Representative (MR) conversations strictly using a **semantic, MECE, gradient-based scoring system**.

You will be given:

1. **Transcript of the MR–doctor conversation**
2. **Brand guide (containing brand name, mandatory USP list, approved claims, clinical endpoints, accuracy standards, and sequence)**
3. **Medicine name**

{transcription}, {brand_guide}, {medicine}

Your job is to compute a total score out of 100 based on the predefined rubric.
All evaluation should be semantic, not keyword-based.
Never reduce scores in more than one section for the same underlying issue (MECE).

For every subsection where the score is NOT full:
You MUST provide structured corrective feedback.

Each "negative" field MUST contain:
1. "Observed snippet:" → exact or near-exact line(s) from the transcription
2. "Issue:" → why this communication is suboptimal (semantic, not stylistic)
3. "Better example:" → an improved example sentence aligned to brand guide
4. "Next time:" → a clear coaching instruction for the MR

If the subsection has full score, keep "negative" as an empty string.


No section or sub-section can have negative scores; the minimum is always **0**.

Generic feedback is not allowed.
If feedback does not reference the transcription AND provide an improved example,
the evaluation is considered invalid.


Output must be a **strict JSON object** with **overall score**, **section-wise scores**, **subsection-wise scores**, **positive reasoning**, and **negative reasoning**.

---

# ✅ **EVALUATION FRAMEWORK (Follow Exactly)**

## **A. Model Communication Compliance — 30 points**

Score only based on alignment with brand guide.

### **A1. Brand Introduction — 8 points**

* Whether MR clearly introduced brand name
* Whether standard opener (e.g., “Presenting…”) was semantically delivered

### **A2. USP Coverage — 8 points**

* All mandatory features covered
* No extra/hallucinated feature added
* No feature skipped
  → Purely based on brand guide mandatory USP list

### **A3. Indication / Use-case — 8 points**

* Correct patient profile communicated
* Clear problem→solution articulation

### **A4. Sequence Adherence — 6 points**

* Followed page-wise visual aid order
* Logical progression without jumping

**Hard rule:**
If brand introduction missing → subsection A1 = 0 AND flag in negative commentary.

---

## **B. Language & Tonality — 25 points**

### **B1. Clarity & Simplicity — 8 points**

* Simple language
* Doctor-friendly phrasing
* No overpromotion

### **B2. Confidence & Fluency — 7 points**

* Assertiveness
* No hesitant or apologetic tone

### **B3. Fillers / Hesitation — 5 points**

* Minimal fillers
* Smooth delivery

### **B4. Professional Tone — 5 points**

* Respectful, clinical
* Not rambling or time-wasting

---

## **C. Medical / Scientific Accuracy — 25 points**

### **C1. Feature Accuracy — 6 points**

* Numerical values correct
* No exaggeration
* No inaccurate comparisons

### **C2. Clinical Claims — 6 points**

* Only approved endpoints mentioned
* No off-label claims

### **C3. Evidence Alignment — 6 points**

* Outcomes logically linked to product
* No misinterpretation of studies

### **C4. Compliance Safety — 7 points**

* No inducements
* No misleading claims

---

## **D. Closing & Action Orientation — 20 points**

### **D1. Quantified Rx Ask — 10 points**

* Clear quantified ask (e.g., “1 prescription today”)
* Brand name included in ask

**Hard rule:**
If quantified ask missing → D section score = 0 (still provide commentary).

### **D2. Closing Statement — 6 points**

* Direct, confident closure
* Avoids vague terms

### **D3. Follow-up Intent — 4 points**

* Encourages trial/start
* Clear next step

---

# 🔍 **SCORING PRINCIPLES**

* All scoring must be **0 → max range**, never negative
* All scores must be **continuous/gradient-based**, not binary
* Reasoning must be semantic:
  Evaluate *whether the idea was communicated*, not whether words match

---

# 🧠 **OUTPUT FORMAT (STRICT JSON)**

Return ONLY a JSON object in this structure:

{{
  "overall_score": 0-100,
  "sections": {{
    "Model_Communication_Compliance": {{
      "total": 0-30,
      "Brand_Introduction": {{
        "score": 0-8,
        "positive": "",
        "negative": "Observed snippet: ... | Issue: ... | Better example: ... | Next time: ..."
      }},
      "USP_Coverage": {{
        "score": 0-8,
        "positive": "",
        "negative": "Observed snippet: ... | Issue: ... | Better example: ... | Next time: ..."
      }},
      "Indication_Usecase": {{
        "score": 0-8,
        "positive": "",
        "negative": "Observed snippet: ... | Issue: ... | Better example: ... | Next time: ..."
      }},
      "Sequence_Adherence": {{
        "score": 0-6,
        "positive": "",
        "negative": "Observed snippet: ... | Issue: ... | Better example: ... | Next time: ..."
      }}
    }},
    "Language_Tonality": {{
      "total": 0-25,
      "Clarity_Simplicity": {{
        "score": 0-8,
        "positive": "",
        "negative": "Observed snippet: ... | Issue: ... | Better example: ... | Next time: ..."
      }},
      "Confidence_Fluency": {{
        "score": 0-7,
        "positive": "",
        "negative": "Observed snippet: ... | Issue: ... | Better example: ... | Next time: ..."
      }},
      "Fillers_Hesitation": {{
        "score": 0-5,
        "positive": "",
        "negative": "Observed snippet: ... | Issue: ... | Better example: ... | Next time: ..."
      }},
      "Professional_Tone": {{
        "score": 0-5,
        "positive": "",
        "negative": "Observed snippet: ... | Issue: ... | Better example: ... | Next time: ..."
      }}
    }},
    "Medical_Scientific_Accuracy": {{
      "total": 0-25,
      "Feature_Accuracy": {{
        "score": 0-6,
        "positive": "",
        "negative": "Observed snippet: ... | Issue: ... | Better example: ... | Next time: ..."
      }},
      "Clinical_Claims": {{
        "score": 0-6,
        "positive": "",
        "negative": "Observed snippet: ... | Issue: ... | Better example: ... | Next time: ..."
      }},
      "Evidence_Alignment": {{
        "score": 0-6,
        "positive": "",
        "negative": "Observed snippet: ... | Issue: ... | Better example: ... | Next time: ..."
      }},
      "Compliance_Safety": {{
        "score": 0-7,
        "positive": "",
        "negative": "Observed snippet: ... | Issue: ... | Better example: ... | Next time: ..."
      }}
    }},
    "Closing_Action_Orientation": {{
      "total": 0-20,
      "Quantified_Rx_Ask": {{
        "score": 0-10,
        "positive": "",
        "negative": "Observed snippet: ... | Issue: ... | Better example: ... | Next time: ..."
      }},
      "Closing_Statement": {{
        "score": 0-6,
        "positive": "",
        "negative": "Observed snippet: ... | Issue: ... | Better example: ... | Next time: ..."
      }},
      "Followup_Intent": {{
        "score": 0-4,
        "positive": "",
        "negative": "Observed snippet: ... | Issue: ... | Better example: ... | Next time: ..."
      }}
    }}
  }},
  "summary": {{
    "strengths": [],
    "improvement_areas": []
  }}
}}


--------------------------------------
IMPROVEMENT AREAS GENERATION

After scoring is complete, populate the "summary.improvement_areas" array with 4–5 items.

These must be:
- Forward-looking actionable instructions for the NEXT CALL.
- Never say “you missed”, “not mentioned”, “failed to”, or similar.
- Never reference scores, deductions, met, missed, or violations.
- Each item must start with a strong verb.
- Each sentence must be imperative and concise.
-Each item must address a SINGLE improvement point.
-Each iteam shuld have a one-word keyword prefix followed by a colon explaing it in short .

Examples:
- "opening:-Open the call with a clear presentation intent using the exact brand name."
- "facts:-State all numeric product facts exactly as provided in the brand guide."
- "closing:-Insert a quantified prescription ask in the closing."
- "repeat:-Repeat the brand name immediately before the closing ask."
- "action:-Replace vague closing phrases with a confident call to action."
- "link:-Link the patient problem directly to the product solution."
- "order:-Follow the mandatory USP sequence without re-ordering."
- "filler:-Eliminate filler and hesitation phrases throughout the call."
- "truth:-Use only approved clinical claims from the brand guide."
- "ending:-End the interaction by confirming the next follow-up action."

Rules:
- Return 4 to 5 items only and for each iteam create a keyword explaining it in one word .
- No bullet symbols — return as a JSON string array.
"""


def analyze_transcription_text_and_update_db(row_id: int, transcription: str, medicine: str, model: Optional[str] = None) -> str:
    # 1) Build prompt (truncate transcription if too long)
    max_chars = 30000
    if len(transcription) > max_chars:
        # keep first and last parts
        transcription = transcription[:15000] + "\n\n...TRUNCATED...\n\n" + transcription[-15000:]

    # 2) Fetch brand guide from DB (extracted_text + usp_points)
    logger.info(f"Fetching brand guide from DB for medicine: {medicine}")
    brand_guide_row = get_brand_guide_from_db(medicine)
    
    if not brand_guide_row:
        logger.error(f"No brand guide found in DB for medicine '{medicine}' - HARD FAIL")
        raise ValueError(f"No brand guide found in DB for medicine: {medicine}")
    
    brand_guide_text = brand_guide_row.get("extracted_text")
    usp_points = brand_guide_row.get("usp_points")
    
    # 3) Validate extracted text
    if not brand_guide_text or len(brand_guide_text) < 200:
        logger.error(f"Brand guide extracted_text missing or too short for {medicine} - HARD FAIL")
        raise ValueError(f"Brand guide extracted_text missing or too short for {medicine}")
    
    # Truncate brand_guide_text and usp_points to prevent prompt overflow
    if len(brand_guide_text) > 6000:
        brand_guide_text = brand_guide_text[:6000]
        logger.info(f"Brand guide truncated to 6000 chars")
    
    usp_points_str = str(usp_points or '')
    if len(usp_points_str) > 3000:
        usp_points = usp_points_str[:3000]
        logger.info(f"USP points truncated to 3000 chars")
    
    logger.info(f"Brand guide fetched from DB: {len(brand_guide_text)} characters, USP points: {len(str(usp_points or ''))} chars")
    
    # 4) Fetch previous call data to provide LLM with context (limit to last 2 calls)
    previous_calls_data = fetch_previous_calls_for_llm_context(row_id)[:2]
    previous_calls_context_block = previous_calls_data if previous_calls_data else []
    
    # 5) Build prompt with DB-driven brand guide and USP points
    prompt = build_prompt(transcription, brand_guide_text, medicine, usp_points) + f"""

==========================
PREVIOUS CALL CONTEXT (LAST 5 CALLS - FOR LLM CONTEXT ONLY)
==========================
{json.dumps(previous_calls_context_block)}

You must compute HISTORICAL DELTA ANALYSIS strictly from these notes.
    """
    logger.info("Calling LLM for row_id=%s", row_id)

    # Call LLM and parse JSON response
    try:
        analysis_text = call_chatgpt(prompt, model=model)
    except Exception as e:
        error_msg = f"LLM error: {e}. Check OPENAI_API_KEY and API access."
        logger.error(error_msg)
        raise RuntimeError(error_msg)
    
    logger.debug("LLM raw response (first 500 chars): %s", analysis_text[:500])
    
    # Parse JSON response - fail hard on invalid JSON
    try:
        result = json.loads(analysis_text)
    except json.JSONDecodeError:
        logger.error("LLM returned NON-JSON output:\n%s", analysis_text[:300])
        raise RuntimeError("LLM failed to return valid JSON – analysis aborted.")
    
    # Validate required fields
    if "overall_score" not in result or "sections" not in result:
        raise ValueError("LLM response missing required fields (overall_score, sections)")
    
    if "summary" not in result:
        raise ValueError("LLM response missing summary field")

    # Enforce hard compliance server-side
    sections = result["sections"]
    
    # Recompute overall score deterministically from sections using "total" field
    overall_score = sum(sec.get("total", 0) for sec in sections.values())
    result["overall_score"] = overall_score
    
    # Compute overall_label
    if overall_score >= 85:
        overall_label = "Excellent"
    elif overall_score >= 70:
        overall_label = "Good"
    else:
        overall_label = "Needs Coaching"
    
    result["overall_label"] = overall_label
    
    # Build track payload from improvement_areas
    track_payload = {
        "overall_score": overall_score,
        "sections": {},
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    }
    
    # Map section names to track format
    section_mapping = {
        "Model_Communication_Compliance": {"key": "model_communication_compliance", "max": 30},
        "Language_Tonality": {"key": "language_quality_clarity", "max": 25},
        "Medical_Scientific_Accuracy": {"key": "medical_scientific_accuracy", "max": 25},
        "Closing_Action_Orientation": {"key": "closing_action_orientation", "max": 20}
    }
    
    for section_name, section_data in sections.items():
        if section_name in section_mapping:
            mapped = section_mapping[section_name]
            track_payload["sections"][mapped["key"]] = {
                "score": section_data.get("total", 0),
                "max": mapped["max"],
                "critical_issues": []
            }
    
    # Extract critical issues from negative fields in subsections
    for section_name, section_data in sections.items():
        if section_name not in section_mapping:
            continue
        mapped_key = section_mapping[section_name]["key"]
        critical_issues = []
        
        for subsection_name, subsection_data in section_data.items():
            if subsection_name == "total":
                continue
            if isinstance(subsection_data, dict):
                negative = subsection_data.get("negative", "").strip()
                if negative:
                    critical_issues.append(negative)
        
        # Limit to max 3 issues per section
        track_payload["sections"][mapped_key]["critical_issues"] = critical_issues[:3]

    
    # Store JSON + score in DB only
    # NOTE: previous_calls_context_block is used ONLY for LLM prompt context during call analysis.
    # It is NOT stored in the database. History analysis uses ONLY the analysis JSON field.
    if row_id and row_id > 0:
        conn = get_db_conn()
        try:
            cursor = conn.cursor()
            analysis_json = json.dumps(result)
            
            cursor.execute(
                """UPDATE audio_recordings 
                   SET analysis = %s,
                       score = %s,
                       track = %s,
                       updated_at = NOW()
                   WHERE id = %s""",
                (
                    analysis_json,
                    overall_score,
                    json.dumps(track_payload),
                    row_id,
                ),
            )
            conn.commit()
            cursor.close()
            logger.info("Updated recording %s: score=%s, label=%s", row_id, overall_score, overall_label)
        finally:
            conn.close()

    # Return the JSON object
    return result


# -------- Job queue & status ----------
JOB_QUEUE: "queue.Queue" = queue.Queue()
JOB_STATUS: Dict[str, Dict[str, Any]] = {}


def mask_key(k: Optional[str]) -> str:
    if not k:
        return "<missing>"
    s = str(k)
    if len(s) <= 8:
        return s[:4] + "..."
    return s[:6] + "..."


def worker_loop():
    logger.info("Analysis worker thread started (OPENAI=%s)", mask_key(OPENAI_API_KEY))
    while True:
        try:
            job = JOB_QUEUE.get()
            if not job:
                continue
            job_id = job.get("job_id")
            row_id = job.get("id")
            medicine = job.get("medicine")
            JOB_STATUS[job_id]["status"] = "started"
            JOB_STATUS[job_id]["started_at"] = time.time()
            logger.info("Job queued -> started: %s row_id=%s medicine=%s", job_id, row_id, medicine)
            try:
                # fetch transcription
                conn = get_db_conn()
                try:
                    cur = conn.cursor(dictionary=True)
                    cur.execute("SELECT id, transcription FROM audio_recordings WHERE id = %s", (row_id,))
                    row = cur.fetchone()
                    cur.close()
                finally:
                    conn.close()

                if not row or not row.get("transcription"):
                    JOB_STATUS[job_id]["status"] = "failed"
                    JOB_STATUS[job_id]["error"] = "transcription missing"
                    logger.warning("Job %s failed: transcription missing for id=%s", job_id, row_id)
                elif not medicine:
                    JOB_STATUS[job_id]["status"] = "failed"
                    JOB_STATUS[job_id]["error"] = "medicine field missing"
                    logger.warning("Job %s failed: medicine missing for id=%s", job_id, row_id)
                else:
                    try:
                        result = analyze_transcription_text_and_update_db(row_id, row.get("transcription"), medicine)
                        JOB_STATUS[job_id]["status"] = "finished"
                        JOB_STATUS[job_id]["result"] = {
                            "overall_score": result.get("overall_score"),
                            "overall_label": result.get("overall_label")
                        }
                        logger.info("Job finished: %s row_id=%s score=%s", job_id, row_id, result.get("overall_score"))
                    except RuntimeError as e:
                        if "OPENAI_RATE_LIMITED" in str(e):
                            logger.error("Job %s failed: OpenAI rate limited (429)", job_id)
                            JOB_STATUS[job_id]["status"] = "failed"
                            JOB_STATUS[job_id]["error"] = "OPENAI_RATE_LIMITED"
                        else:
                            JOB_STATUS[job_id]["status"] = "failed"
                            JOB_STATUS[job_id]["error"] = str(e)
                            logger.exception("Job %s failed during analysis: %s", job_id, e)
                    except Exception as e:
                        JOB_STATUS[job_id]["status"] = "failed"
                        JOB_STATUS[job_id]["error"] = str(e)
                        logger.exception("Job %s failed during analysis: %s", job_id, e)
            except Exception as e:
                JOB_STATUS[job_id]["status"] = "failed"
                JOB_STATUS[job_id]["error"] = str(e)
                logger.exception("Unexpected worker error for job %s: %s", job_id, e)
            finally:
                JOB_QUEUE.task_done()
        except Exception:
            logger.exception("Uncaught error in worker loop")


# start background worker thread
_worker_thread = threading.Thread(target=worker_loop, daemon=True)
_worker_thread.start()


# -------- Endpoints ----------

# -------- History Analysis (second-order intelligence) ----------

class HistoryAnalysisRequest(BaseModel):
    recorded_by: str


def fetch_recent_analyses(recorded_by: str, limit: int = 5) -> list:
    """Fetch the last N completed call analyses for a given user.
    
    Uses ONLY the analysis field (canonical source of truth).
    IMPORTANT: Records are ordered NEWEST → OLDEST by created_at DESC.
    This ordering is critical for trend calculations (see analyze_section_trends).
    
    Args:
        recorded_by: User name to filter by
        limit: Number of recent analyses to fetch (default 5)
    
    Returns:
        List of records with analysis JSON, ordered newest first
    """
    conn = get_db_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("""
            SELECT id, analysis, created_at, title
            FROM audio_recordings
            WHERE recorded_by = %s AND analysis IS NOT NULL
            ORDER BY created_at DESC
            LIMIT %s
        """, (recorded_by, limit))
        rows = cur.fetchall()
        cur.close()
        return rows
    finally:
        conn.close()


def parse_analysis_json(analysis_raw: Any) -> Optional[dict]:
    """Safely parse analysis JSON.
    
    Args:
        analysis_raw: Raw analysis data (string or dict)
    
    Returns:
        Parsed analysis dict or None if invalid
    """
    if not analysis_raw:
        return None
    try:
        if isinstance(analysis_raw, str):
            return json.loads(analysis_raw)
        return analysis_raw
    except Exception as e:
        logger.warning("Failed to parse analysis JSON: %s", str(e)[:100])
        return None


def generate_history_insights(records: list) -> dict:
    """Generate AI-powered history insights using LLM analysis.
    
    Backend role: TRANSPORT LAYER ONLY
    - Fetches data
    - Sends prompt
    - Validates JSON structure
    - Adds timestamp
    - Returns LLM response as-is
    
    LLM role: SOLE INTELLIGENCE
    - All interpretation
    - All reasoning
    - All narrative
    
    Uses ONLY analysis JSON field from last 5 calls. Does not touch track or history_block.
    Records are ordered NEWEST → OLDEST from fetch_recent_analyses.
    
    Args:
        records: List of audio_recordings with analysis field, ordered newest first
    
    Returns:
        Structured history insights JSON with LLM-generated trajectory and trends
    """
    if not records or len(records) < 2:
        raise ValueError("At least 2 analyzed calls required for history analysis")
    
    # Parse all analysis JSON
    analyses = []
    for record in records:
        analysis = parse_analysis_json(record.get("analysis"))
        if analysis:
            analyses.append(analysis)
    
    if len(analyses) < 2:
        raise ValueError("Insufficient valid analysis data. At least 2 calls must have complete analysis")
    
    # Build prompt with only analysis JSON data
    analyses_json = json.dumps(analyses, indent=2)
    
    prompt = f"""You are an expert performance coach analyzing historical performance across multiple evaluated sales calls.

CRITICAL: You are analyzing FINAL EVALUATION OUTPUTS only. You are NOT analyzing raw conversations. You are NOT re-scoring calls.

You have been given the final evaluation outputs of the last {len(analyses)} calls (scores, sections, reasoning).

Your task is to:
1. Detect performance trajectory over time (improving, declining, stable, or volatile)
2. Identify consistent improvements across sections
3. Identify regressions or weak patterns
4. Determine the single most important coaching focus
5. Reason SEMANTICALLY and NARRATIVELY

Focus on describing:
- Performance consistency and changes in natural language
- Qualitative patterns and evolution
- Coaching insights

Do NOT compute or reference raw calculations unless semantically meaningful.

Call Evaluation Data (newest to oldest):
{analyses_json}

You MUST return ONLY valid JSON with this EXACT structure:
{{
  "trajectory": "improving | declining | stable | volatile",
  "trajectory_reasoning": "semantic, narrative explanation of overall performance evolution",
  "section_wise_trends": {{
    "Model Communication Compliance": {{
      "trend": "improving | declining | stable",
      "reasoning": "narrative explanation of this section's evolution"
    }},
    "Language Tonality": {{
      "trend": "improving | declining | stable",
      "reasoning": "narrative explanation"
    }},
    "Medical Scientific Accuracy": {{
      "trend": "improving | declining | stable",
      "reasoning": "narrative explanation"
    }},
    "Closing Action Orientation": {{
      "trend": "improving | declining | stable",
      "reasoning": "narrative explanation"
    }}
  }},
  "key_improvements": ["improvement 1", "improvement 2"],
  "key_regressions": ["regression 1"],
  "coaching_focus": "the single most important focus area for next call",
  "calls_analyzed": {len(analyses)}
}}

Return ONLY the JSON. No preamble. No explanation. Valid JSON only."""
    
    # Call LLM for history analysis
    try:
        llm_response = call_chatgpt(prompt, model=None)
    except RuntimeError as e:
        if "OPENAI_RATE_LIMITED" in str(e):
            raise HTTPException(status_code=429, detail="LLM temporarily rate-limited. Please retry.")
        logger.error("LLM call failed for history analysis: %s", str(e))
        raise RuntimeError(f"Failed to generate history insights: {str(e)}")
    
    # Parse LLM response
    try:
        history_insights = json.loads(llm_response)
    except json.JSONDecodeError as e:
        logger.error("Failed to parse history insights JSON: %s", llm_response[:500])
        raise RuntimeError(f"LLM returned invalid JSON: {str(e)}")
    
    # Validate required fields
    required_fields = ["trajectory", "trajectory_reasoning", "section_wise_trends", 
                      "key_improvements", "key_regressions", "coaching_focus", "calls_analyzed"]
    for field in required_fields:
        if field not in history_insights:
            raise ValueError(f"Missing required field in history insights: {field}")
    
    # Add ONLY timestamp (backend is transport layer, LLM owns all interpretation)
    history_insights["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    
    # Return LLM response as-is (no backend computation of averages, deltas, or trends)
    return history_insights


@app.post("/api/history_analysis")
def history_analysis(req: HistoryAnalysisRequest):
    """Perform AI-powered history analysis on stored call analysis data.
    
    This endpoint:
    - Fetches last 5 completed call analyses (where analysis IS NOT NULL)
    - Passes only analysis JSON to LLM for second-order reasoning
    - Returns LLM-generated history-level insights
    - Does NOT re-run transcription analysis
    - Does NOT call OpenAI for individual calls (only for history analysis)
    - Does NOT modify call-level scores
    - Does NOT read track or history_block
    - Does NOT write to database
    """
    try:
        if not req.recorded_by:
            raise HTTPException(status_code=400, detail="recorded_by field required")
        
        # Fetch recent analyses (using analysis field only)
        records = fetch_recent_analyses(req.recorded_by, limit=5)
        
        if not records or len(records) < 2:
            raise HTTPException(
                status_code=400,
                detail="Insufficient history data. Please complete at least 2 analyzed calls to generate history insights.",
            )
        
        # Generate insights using LLM analysis of past evaluations
        insights = generate_history_insights(records)
        
        logger.info("History analysis completed for user=%s with %d calls", req.recorded_by, len(records))
        
        return {
            "ok": True,
            "history_insights": insights,
        }
    
    except ValueError as e:
        logger.warning("History analysis validation error: %s", str(e))
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("History analysis error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/analyze_by_id")
def analyze_by_id(req: AnalyzeByIdRequest):
    # 1) fetch transcription by id
    conn = get_db_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT id, transcription FROM audio_recordings WHERE id = %s", (req.id,))
        row = cur.fetchone()
        cur.close()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="recording not found")

    transcription = row.get("transcription", "")
    if not transcription:
        raise HTTPException(status_code=400, detail="transcription empty")

    if not req.medicine:
        raise HTTPException(status_code=400, detail="medicine field required")

    try:
        result = analyze_transcription_text_and_update_db(req.id, transcription, req.medicine, model=req.model)
        return {
            "ok": True,
            "result": result
        }
    except RuntimeError as e:
        if "OPENAI_RATE_LIMITED" in str(e):
            raise HTTPException(status_code=429, detail="OpenAI rate limited. Please retry.")
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/analyze_inline")
def analyze_inline(req: AnalyzeInlineRequest):
    if not req.transcription or not req.transcription.strip():
        raise HTTPException(status_code=400, detail="transcription required")
    if not req.medicine:
        raise HTTPException(status_code=400, detail="medicine field required")
    try:
        result = analyze_transcription_text_and_update_db(-1, req.transcription, req.medicine, model=req.model)
        return {
            "ok": True,
            "result": result
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/analyze_by_id_async")
def analyze_by_id_async(req: AnalyzeByIdRequest):
    if not req.medicine:
        raise HTTPException(status_code=400, detail="medicine field required")
    
    # enqueue and return job id immediately
    job_id = str(uuid.uuid4())
    JOB_STATUS[job_id] = {"status": "queued", "id": req.id, "medicine": req.medicine, "created_at": time.time()}
    JOB_QUEUE.put({"job_id": job_id, "id": req.id, "medicine": req.medicine, "model": req.model})
    logger.info("Enqueued analysis job %s for id=%s medicine=%s", job_id, req.id, req.medicine)
    return {"ok": True, "job_id": job_id}


@app.get("/api/debug/recording/{recording_id}")
def debug_get_recording(recording_id: int):
    """Debug endpoint to inspect what's stored in DB for a recording."""
    try:
        conn = get_db_conn()
        try:
            cur = conn.cursor(dictionary=True)
            cur.execute("""
                SELECT id, title, analysis, track, history_block
                FROM audio_recordings WHERE id = %s
            """, (recording_id,))
            row = cur.fetchone()
            cur.close()
        finally:
            conn.close()
        
        if not row:
            raise HTTPException(status_code=404, detail=f"Recording {recording_id} not found")
        
        analysis = row.get("analysis")
        logger.info("DEBUG: Raw analysis from DB (first 500 chars): %s", str(analysis)[:500] if analysis else "NULL")
        
        parsed = None
        parse_error = None
        if analysis and isinstance(analysis, str):
            try:
                parsed = json.loads(analysis)
            except json.JSONDecodeError as e:
                parse_error = str(e)
                logger.error("DEBUG: Failed to parse analysis as JSON: %s", e)
        
        raw_history = row.get("history_block")
        parsed_history = None
        if raw_history:
            try:
                parsed_history = json.loads(raw_history)
            except Exception:
                logger.error("Failed to decode history_block JSON")
        
        raw_track = row.get("track")
        parsed_track = None
        if raw_track:
            try:
                parsed_track = json.loads(raw_track)
            except Exception:
                logger.error("Failed to decode track JSON")
        
        return {
            "id": row.get("id"),
            "title": row.get("title"),
            "analysis_parsed": parsed,
            "track": parsed_track,
            "history_block": parsed_history,
            "parse_error": parse_error
        }
    except Exception as e:
        logger.exception("Debug endpoint error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/analysis_status")
def analysis_status(job_id: str):
    if not job_id:
        raise HTTPException(status_code=400, detail="job_id query param required")
    status = JOB_STATUS.get(job_id)
    if not status:
        raise HTTPException(status_code=404, detail="job not found")
    return {"ok": True, "job_id": job_id, "status": status} 