import fs from "fs";

/**
 * Transcribe an audio file using the `whisper-node` npm package.
 * This wrapper dynamically imports the package and attempts several
 * common API shapes so it's tolerant to variations in the package
 * exports. If `whisper-node` is not installed it will throw a clear
 * error instructing how to install it.
 *
 * Returns a plain string with the transcription (best-effort).
 */
export async function transcribeFile(filePath, opts = {}) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("transcribeFile requires a valid filePath string");
  }

  let mod;
  try {
    mod = await import("whisper-node");
  } catch (err) {
    throw new Error(
      "Package `whisper-node` not found. Please run `npm install whisper-node` and restart the server."
    );
  }

  const impl = mod.default || mod;

  function extractText(resp) {
    if (!resp) return "";
    if (typeof resp === "string") return resp;
    if (resp.text) return resp.text;
    if (resp.transcript) return resp.transcript;
    if (resp.result) return resp.result;
    if (Array.isArray(resp)) return resp.map((r) => extractText(r)).join(" ");
    if (resp.results && Array.isArray(resp.results))
      return resp.results.map((r) => extractText(r)).join(" ");
    try {
      return JSON.stringify(resp);
    } catch (e) {
      return String(resp);
    }
  }

  // If the module itself is callable
  if (typeof impl === "function") {
    const result = await impl(filePath, opts);
    return extractText(result);
  }

  const candidateFns = [
    "transcribe",
    "speechToText",
    "recognize",
    "speech_to_text",
    "run",
    "process",
  ];

  for (const name of candidateFns) {
    if (typeof impl[name] === "function") {
      const result = await impl[name](filePath, opts);
      return extractText(result);
    }
  }

  if (impl.whisper && typeof impl.whisper === "function") {
    const result = await impl.whisper(filePath, opts);
    return extractText(result);
  }

  if (impl.client && typeof impl.client === "function") {
    const result = await impl.client(filePath, opts);
    return extractText(result);
  }

  throw new Error(
    "Could not find a usable transcription function on the installed `whisper-node` package.\nPlease check the package docs for the correct API."
  );
}
