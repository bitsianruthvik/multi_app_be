#!/usr/bin/env node

/**
 * Unit test for analysisFormatter
 * Tests with the exact SAMPLE INPUT from specification
 */

import { formatAnalysis } from "./analysisFormatter.js";

const SAMPLE_INPUT = {
  analysis_text:
    "The transcript provided does not contain sufficient domain-specific context about Oncaryva™ (rovelcitib mesylate) or its clinical application to generate a meaningful analysis. The content is primarily a technical check rather than a discussion of the pharmaceutical product.",
  score: null,
  keywords: [
    "FGFR2",
    "cholangiocarcinoma",
    "VEGFR3",
    "kinase inhibitor",
    "targeted therapy",
  ],
  key_learning_areas: [
    "FGFR2 inhibition",
    "VEGFR3 role",
    "Tumor lymphangiogenesis",
    "Pharmacokinetic profile",
  ],
  descriptive_analysis:
    "The transcript lacks substantive discussion of Oncaryva™ or its clinical relevance. The factsheet details mechanism (FGFR2/VEGFR3) but none of this is referenced in the transcript. The transcript appears to be a technical test rather than a sales call; no efficacy data or trial results are referenced.",
};

console.log("Running analysisFormatter unit test...\n");
console.log("=".repeat(50));

try {
  // Test 1: Call formatter with object
  console.log("\n[TEST 1] Formatting with object input...");
  const result = formatAnalysis(SAMPLE_INPUT);

  // Verify result structure
  if (!result.textReport || typeof result.textReport !== "string") {
    throw new Error("textReport is missing or not a string");
  }
  if (!result.finalJson || typeof result.finalJson !== "object") {
    throw new Error("finalJson is missing or not an object");
  }

  console.log("✓ Result structure is valid");

  // Test 2: Verify textReport has required separators
  console.log("\n[TEST 2] Checking textReport format...");
  if (
    !result.textReport.includes("==========================") ||
    !result.textReport.includes(" ANALYSIS REPORT") ||
    !result.textReport.includes(" END OF REPORT")
  ) {
    throw new Error("textReport missing required separators");
  }
  console.log("✓ textReport has correct separators");

  // Test 3: Verify all 9 sections present
  console.log("\n[TEST 3] Checking all 9 sections...");
  const requiredSections = [
    "1. SUMMARY OVERVIEW",
    "2. METADATA",
    "3. SCORE",
    "4. KEYWORDS (AUTO-EXTRACTED)",
    "5. KEY LEARNING AREAS (SKILL GAPS)",
    "6. DETAILED DESCRIPTIVE ANALYSIS",
    "7. TECHNICAL RECOMMENDATIONS",
    "8. CONTEXTUAL RELEVANCE EVALUATION",
    "9. FINAL SYSTEM-READY PAYLOAD (CLEAN JSON)",
  ];

  let missingSections = [];
  requiredSections.forEach((section) => {
    if (!result.textReport.includes(section)) {
      missingSections.push(section);
    }
  });

  if (missingSections.length > 0) {
    throw new Error(`Missing sections: ${missingSections.join(", ")}`);
  }
  console.log("✓ All 9 sections present");

  // Test 4: Verify finalJson has required keys
  console.log("\n[TEST 4] Checking finalJson keys...");
  const requiredKeys = [
    "analysis_text",
    "score",
    "keywords",
    "key_learning_areas",
    "descriptive_analysis",
  ];
  let missingKeys = [];
  requiredKeys.forEach((key) => {
    if (!(key in result.finalJson)) {
      missingKeys.push(key);
    }
  });

  if (missingKeys.length > 0) {
    throw new Error(`finalJson missing keys: ${missingKeys.join(", ")}`);
  }
  console.log("✓ finalJson has all required keys");

  // Test 5: Verify array deduplication
  console.log("\n[TEST 5] Checking array deduplication...");
  const inputKeywords = SAMPLE_INPUT.keywords;
  const outputKeywords = result.finalJson.keywords;

  if (new Set(outputKeywords).size !== outputKeywords.length) {
    throw new Error("Keywords are not deduplicated");
  }
  if (outputKeywords.some((k) => k !== k.trim())) {
    throw new Error("Keywords contain leading/trailing whitespace");
  }
  console.log(
    `✓ Keywords properly deduplicated and trimmed (${outputKeywords.length} items)`
  );

  // Test 6: Verify Score is NULL when null
  console.log("\n[TEST 6] Checking NULL score display...");
  if (!result.textReport.includes("Score: NULL")) {
    throw new Error("NULL score not displayed correctly");
  }
  console.log("✓ NULL score displayed correctly");

  // Test 7: Test with JSON string input
  console.log("\n[TEST 7] Testing with JSON string input...");
  const jsonString = JSON.stringify(SAMPLE_INPUT);
  const resultFromString = formatAnalysis(jsonString);

  if (!resultFromString.textReport || !resultFromString.finalJson) {
    throw new Error("Failed to parse JSON string input");
  }
  if (
    JSON.stringify(result.finalJson) !==
    JSON.stringify(resultFromString.finalJson)
  ) {
    throw new Error("Results differ between object and string input");
  }
  console.log("✓ JSON string input produces identical result");

  // Test 8: Test invalid JSON handling
  console.log("\n[TEST 8] Testing invalid JSON handling...");
  const invalidResult = formatAnalysis("{ invalid json }");

  if (invalidResult.finalJson !== null) {
    throw new Error("Should return null finalJson for invalid input");
  }
  if (!invalidResult.textReport.includes("INVALID_JSON_INPUT")) {
    throw new Error("Should show INVALID_JSON_INPUT message");
  }
  console.log("✓ Invalid JSON handled gracefully");

  console.log("\n" + "=".repeat(50));
  console.log("\n✓✓✓ ALL TESTS PASSED ✓✓✓\n");

  // Print sample output
  console.log("Sample output (first 35 lines of textReport):\n");
  const lines = result.textReport.split("\n").slice(0, 35);
  lines.forEach((line) => console.log(line));

  console.log("\n...\n");
  console.log("finalJson output:\n");
  console.log(JSON.stringify(result.finalJson, null, 2));

  process.exit(0);
} catch (error) {
  console.error("\n✗ TEST FAILED:", error.message);
  console.error("\nStack:", error.stack);
  process.exit(1);
}
