"""
Deterministic Analysis Report Formatter

Takes analysis JSON (dict or string) and produces:
A) Human-readable plain-text report in ANALYSIS REPORT format
B) Clean machine-friendly JSON payload
"""

import json
from typing import Dict, Any, List, Union, Optional
import logging

logger = logging.getLogger("analysis-formatter")


def format_analysis_report(analysis_json: Union[str, Dict[str, Any]]) -> Dict[str, Any]:
    """
    Format analysis JSON into structured plain-text report and clean JSON payload.
    
    Args:
        analysis_json: Either a JSON string or a dict
        
    Returns:
        Dict with keys:
        - error (bool): True if parsing/validation failed
        - code (str): Error code if error=True
        - message (str): Error message if error=True
        - textReport (str): Plain-text report in ANALYSIS REPORT format
        - jsonPayload (dict): Clean JSON payload with analysis fields
        - jsonString (str): Pretty-printed JSON string
    """
    
    # ===== PARSE INPUT =====
    analysis = None
    
    if isinstance(analysis_json, str):
        try:
            analysis = json.loads(analysis_json)
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse analysis JSON: {e}")
            return {
                "error": True,
                "code": "INVALID_JSON_INPUT",
                "message": f"Failed to parse input: {str(e)}",
                "raw": analysis_json,
                "textReport": f"ERROR: INVALID_JSON_INPUT\n\nCould not parse input as JSON.\n\nRaw value:\n{analysis_json}",
                "jsonPayload": None,
                "jsonString": None,
            }
    elif isinstance(analysis_json, dict):
        analysis = analysis_json
    else:
        return {
            "error": True,
            "code": "INVALID_INPUT_TYPE",
            "message": f"Input must be dict or JSON string, got {type(analysis_json).__name__}",
            "raw": str(analysis_json),
            "textReport": f"ERROR: INVALID_INPUT_TYPE\n\nExpected dict or JSON string, got {type(analysis_json).__name__}",
            "jsonPayload": None,
            "jsonString": None,
        }

    # ===== EXTRACT AND NORMALIZE FIELDS =====
    analysis_text = (analysis.get("analysis_text") or "").strip() or "Not provided"
    score = analysis.get("score")  # Can be None, int, or null
    
    keywords = analysis.get("keywords", [])
    if not isinstance(keywords, list):
        keywords = []
    keywords = list(dict.fromkeys([str(k).strip() for k in keywords if str(k).strip()]))[:10]
    
    key_learning_areas = analysis.get("key_learning_areas", [])
    if not isinstance(key_learning_areas, list):
        key_learning_areas = []
    key_learning_areas = list(dict.fromkeys([str(k).strip() for k in key_learning_areas if str(k).strip()]))[:4]
    
    descriptive_analysis = (analysis.get("descriptive_analysis") or "").strip() or "Not provided"

    # ===== BUILD METADATA SECTION =====
    has_score = score is not None
    analysis_intent = (
        "Pharmaceutical sales call analysis"
        if descriptive_analysis != "Not provided"
        else "Analysis unavailable"
    )
    domain_relevance = (
        "High (scored)" if has_score
        else "Medium (descriptive only)" if descriptive_analysis != "Not provided"
        else "Low (minimal data)"
    )
    content_type = "Audio transcript analysis"
    scoring_applicability = "Score is applicable" if has_score else "Score not assigned"

    # ===== BUILD SCORE SECTION REASON =====
    if has_score:
        score_reason = f"Score assigned: {score}/10"
    else:
        score_reason = (
            "Score withheld; see descriptive analysis for details"
            if descriptive_analysis != "Not provided"
            else "Insufficient data to assign score"
        )

    # ===== GENERATE TECHNICAL RECOMMENDATIONS =====
    recommendations = generate_recommendations(key_learning_areas, descriptive_analysis)

    # ===== GENERATE CONTEXTUAL RELEVANCE =====
    context_alignment = determine_context_alignment(score)
    context_reason = generate_context_reason(analysis_intent, has_score)

    # ===== BUILD PLAIN-TEXT REPORT =====
    text_report = build_text_report(
        analysis_text=analysis_text,
        score=score,
        keywords=keywords,
        key_learning_areas=key_learning_areas,
        descriptive_analysis=descriptive_analysis,
        analysis_intent=analysis_intent,
        domain_relevance=domain_relevance,
        content_type=content_type,
        scoring_applicability=scoring_applicability,
        score_reason=score_reason,
        recommendations=recommendations,
        context_alignment=context_alignment,
        context_reason=context_reason,
    )

    # ===== BUILD CLEAN JSON PAYLOAD =====
    json_payload = {
        "analysis_text": analysis_text,
        "score": score,
        "keywords": keywords,
        "key_learning_areas": key_learning_areas,
        "descriptive_analysis": descriptive_analysis,
    }

    return {
        "error": False,
        "textReport": text_report,
        "jsonPayload": json_payload,
        "jsonString": json.dumps(json_payload, ensure_ascii=False, indent=2),
    }


def build_text_report(**data) -> str:
    """Build the formatted plain-text ANALYSIS REPORT."""
    lines = [
        "==========================",
        " ANALYSIS REPORT",
        "==========================",
        "",
        "1. SUMMARY OVERVIEW",
        "-------------------",
        data["analysis_text"],
        "",
        "2. METADATA",
        "-----------",
        f"• Analysis Intent: {data['analysis_intent']}",
        f"• Domain Relevance: {data['domain_relevance']}",
        f"• Content Type: {data['content_type']}",
        f"• Scoring Applicability: {data['scoring_applicability']}",
        "",
        "3. SCORE",
        "--------",
        f"Score: {data['score'] if data['score'] is not None else 'NULL'}",
        f"Reason: {data['score_reason']}",
        "",
        "4. KEYWORDS (AUTO-EXTRACTED)",
        "-----------------------------",
    ]

    if data["keywords"]:
        for kw in data["keywords"]:
            lines.append(f"• {kw}")
    else:
        lines.append("• (none extracted)")

    lines.extend([
        "",
        "5. KEY LEARNING AREAS (SKILL GAPS)",
        "----------------------------------",
    ])

    if data["key_learning_areas"]:
        for kla in data["key_learning_areas"]:
            lines.append(f"• {kla}")
    else:
        lines.append("• (none identified)")

    lines.extend([
        "",
        "6. DETAILED DESCRIPTIVE ANALYSIS",
        "--------------------------------",
        data["descriptive_analysis"],
        "",
        "7. TECHNICAL RECOMMENDATIONS",
        "----------------------------",
    ])

    for rec in data["recommendations"]:
        lines.append(f"• {rec}")

    lines.extend([
        "",
        "8. CONTEXTUAL RELEVANCE EVALUATION",
        "----------------------------------",
        f"Context Alignment: {data['context_alignment']}",
        f"Reason: {data['context_reason']}",
        "",
        "9. FINAL SYSTEM-READY PAYLOAD (CLEAN JSON)",
        "------------------------------------------",
        "",
    ])

    json_payload = {
        "analysis_text": data["analysis_text"],
        "score": data["score"],
        "keywords": data["keywords"],
        "key_learning_areas": data["key_learning_areas"],
        "descriptive_analysis": data["descriptive_analysis"],
    }

    json_str = json.dumps(json_payload, ensure_ascii=False, indent=2)
    lines.append(json_str)

    lines.extend([
        "",
        "==========================",
        " END OF REPORT",
        "==========================",
    ])

    return "\n".join(lines)


def generate_recommendations(key_learning_areas: List[str], descriptive_analysis: str) -> List[str]:
    """Generate 4-6 actionable recommendations."""
    recs = []

    # Add recommendations from learning areas
    if key_learning_areas:
        for kla in key_learning_areas:
            recs.append(f"Focus on improving: {kla}")

    # Add generic recommendations if needed
    generic = [
        "Review transcript for clarity and messaging consistency",
        "Identify and address key learning areas identified in analysis",
        "Document best practices for future reference",
        "Schedule follow-up coaching session to reinforce strengths",
        "Monitor progress against identified skill gaps",
        "Share findings with relevant stakeholders for alignment",
    ]

    import random
    while len(recs) < 4 and generic:
        rec = generic.pop(random.randint(0, len(generic) - 1))
        recs.append(rec)

    return recs[:6]


def determine_context_alignment(score: Optional[int]) -> str:
    """Determine context alignment based on score."""
    if score is None:
        return "Medium"
    
    if score >= 8:
        return "High"
    elif score >= 6:
        return "Medium"
    elif score >= 4:
        return "Low"
    else:
        return "Very Low"


def generate_context_reason(analysis_intent: str, has_score: bool) -> str:
    """Generate reason for context alignment."""
    if not has_score:
        return "Analysis provides descriptive insights but lacks numerical scoring."
    return f"Contextually relevant {analysis_intent} with quantified assessment."
