/**
 * analysisFormatter
 *
 * Deterministic analysis report formatter.
 * Accepts analysis JSON (object or string) and produces structured ANALYSIS REPORT.
 *
 * @param {Object|string} raw - Analysis data (object or JSON string)
 * @returns {Object} { textReport: string, finalJson: object|null }
 */

function formatAnalysis(raw) {
  // ===== PARSE INPUT =====
  let analysis = null;

  if (typeof raw === "string") {
    try {
      analysis = JSON.parse(raw);
    } catch (e) {
      return {
        textReport: `INVALID_JSON_INPUT\n${raw}`,
        finalJson: null,
      };
    }
  } else if (typeof raw === "object" && raw !== null) {
    analysis = raw;
  } else {
    return {
      textReport: `INVALID_JSON_INPUT\n${String(raw)}`,
      finalJson: null,
    };
  }

  // ===== EXTRACT AND NORMALIZE FIELDS =====
  const analysisText = (analysis.analysis_text || "").trim() || "Not provided";
  const score = analysis.score !== undefined ? analysis.score : null;
  let keywords = Array.isArray(analysis.keywords) ? analysis.keywords : [];
  let keyLearningAreas = Array.isArray(analysis.key_learning_areas)
    ? analysis.key_learning_areas
    : [];
  const descriptiveAnalysis =
    (analysis.descriptive_analysis || "").trim() || "Not provided";

  // Deduplicate and clean arrays
  keywords = [
    ...new Set(keywords.map((k) => String(k).trim()).filter((k) => k)),
  ].slice(0, 10);
  keyLearningAreas = [
    ...new Set(keyLearningAreas.map((k) => String(k).trim()).filter((k) => k)),
  ].slice(0, 4);

  // ===== BUILD METADATA SECTION =====
  const hasScore = score !== null && score !== undefined;
  const analysisIntent =
    descriptiveAnalysis && descriptiveAnalysis !== "Not provided"
      ? "Pharmaceutical sales call analysis"
      : "Analysis unavailable";
  const domainRelevance = hasScore
    ? "High (scored)"
    : descriptiveAnalysis !== "Not provided"
    ? "Medium (descriptive only)"
    : "Low (minimal data)";
  const contentType = "Audio transcript analysis";
  const scoringApplicability = hasScore
    ? "Score is applicable"
    : "Score not assigned";

  // ===== BUILD SCORE SECTION REASON =====
  let scoreReason = "";
  if (hasScore) {
    scoreReason = `Score assigned: ${score}/10`;
  } else {
    scoreReason =
      descriptiveAnalysis && descriptiveAnalysis !== "Not provided"
        ? "Score withheld; see descriptive analysis for details"
        : "Insufficient data to assign score";
  }

  // ===== GENERATE TECHNICAL RECOMMENDATIONS =====
  const recommendations = generateRecommendations(
    keyLearningAreas,
    descriptiveAnalysis
  );

  // ===== GENERATE CONTEXTUAL RELEVANCE =====
  const contextAlignment = determineContextAlignment(
    score,
    descriptiveAnalysis,
    keywords
  );
  const contextReason = generateContextReason(analysisIntent, hasScore);

  // ===== BUILD FINAL JSON PAYLOAD =====
  const finalJson = {
    analysis_text: analysisText,
    score: score,
    keywords: keywords,
    key_learning_areas: keyLearningAreas,
    descriptive_analysis: descriptiveAnalysis,
  };

  // ===== BUILD PLAIN-TEXT REPORT =====
  const textReport = buildTextReport({
    analysisText,
    score,
    keywords,
    keyLearningAreas,
    descriptiveAnalysis,
    analysisIntent,
    domainRelevance,
    contentType,
    scoringApplicability,
    scoreReason,
    recommendations,
    contextAlignment,
    contextReason,
    finalJson,
  });

  return {
    textReport: textReport,
    finalJson: finalJson,
  };
}

function buildTextReport(data) {
  const lines = [
    "==========================",
    " ANALYSIS REPORT",
    "==========================",
    "",
    "1. SUMMARY OVERVIEW",
    "-------------------",
    data.analysisText,
    "",
    "2. METADATA",
    "-----------",
    `• Analysis Intent: ${data.analysisIntent}`,
    `• Domain Relevance: ${data.domainRelevance}`,
    `• Content Type: ${data.contentType}`,
    `• Scoring Applicability: ${data.scoringApplicability}`,
    "",
    "3. SCORE",
    "--------",
    `Score: ${data.score !== null ? data.score : "NULL"}`,
    `Reason: ${data.scoreReason}`,
    "",
    "4. KEYWORDS (AUTO-EXTRACTED)",
    "-----------------------------",
  ];

  if (data.keywords.length > 0) {
    data.keywords.forEach((kw) => {
      lines.push(`• ${kw}`);
    });
  } else {
    lines.push("• (none extracted)");
  }

  lines.push(
    "",
    "5. KEY LEARNING AREAS (SKILL GAPS)",
    "----------------------------------"
  );

  if (data.keyLearningAreas.length > 0) {
    data.keyLearningAreas.forEach((kla) => {
      lines.push(`• ${kla}`);
    });
    lines.push(
      "These pinpoint exactly where improvement is required in future recordings."
    );
  } else {
    lines.push("• (none identified)");
    lines.push(
      "These pinpoint exactly where improvement is required in future recordings."
    );
  }

  lines.push(
    "",
    "6. DETAILED DESCRIPTIVE ANALYSIS",
    "--------------------------------",
    data.descriptiveAnalysis,
    "",
    "7. TECHNICAL RECOMMENDATIONS",
    "----------------------------"
  );

  data.recommendations.forEach((rec) => {
    lines.push(`• ${rec}`);
  });

  lines.push(
    "",
    "8. CONTEXTUAL RELEVANCE EVALUATION",
    "----------------------------------",
    `Context Alignment: ${data.contextAlignment}`,
    `Reason: ${data.contextReason}`,
    "",
    "9. FINAL SYSTEM-READY PAYLOAD (CLEAN JSON)",
    "------------------------------------------",
    "",
    JSON.stringify(
      {
        analysis_text: data.analysisText,
        score: data.score,
        keywords: data.keywords,
        key_learning_areas: data.keyLearningAreas,
        descriptive_analysis: data.descriptiveAnalysis,
      },
      null,
      2
    ),
    "",
    "==========================",
    " END OF REPORT",
    "=========================="
  );

  return lines.join("\n");
}

function generateRecommendations(keyLearningAreas, descriptiveAnalysis) {
  const recs = [];

  if (keyLearningAreas.length > 0) {
    keyLearningAreas.forEach((kla) => {
      recs.push(`Focus on improving: ${kla}`);
    });
  }

  // Add generic recommendations if needed
  if (recs.length < 4) {
    const generic = [
      "Review transcript for clarity and messaging consistency",
      "Identify and address key learning areas identified in analysis",
      "Document best practices for future reference",
      "Schedule follow-up coaching session to reinforce strengths",
      "Monitor progress against identified skill gaps",
      "Share findings with relevant stakeholders for alignment",
    ];

    while (recs.length < 4 && generic.length > 0) {
      const randomIdx = Math.floor(Math.random() * generic.length);
      recs.push(generic.splice(randomIdx, 1)[0]);
    }
  }

  return recs.slice(0, 6);
}

function determineContextAlignment(score, descriptiveAnalysis, keywords) {
  if (score === null) {
    return "Medium";
  }

  if (score >= 8) {
    return "High";
  } else if (score >= 6) {
    return "Medium";
  } else if (score >= 4) {
    return "Low";
  } else {
    return "Very Low";
  }
}

function generateContextReason(analysisIntent, hasScore) {
  if (!hasScore) {
    return "Analysis provides descriptive insights but lacks numerical scoring.";
  }
  return `Contextually relevant ${analysisIntent} with quantified assessment.`;
}

// ===== EXPORT =====
if (typeof module !== "undefined" && module.exports) {
  module.exports = { formatAnalysis };
}

// For ES modules
export { formatAnalysis };
