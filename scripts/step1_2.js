console.error(
  "This script has been removed. Use scripts/audio_pipeline.py for audio processing."
);
process.exit(1);
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import fs from "fs";
import path from "path";

ffmpeg.setFfmpegPath(ffmpegPath || "ffmpeg");

// Use the requested audio file from public/uploads
const inputRelative = "public/uploads/original_1762781137383.mp3";
const input = path.resolve(inputRelative);
const filtered = path.resolve("filtered.mp3");

function applyBandpassOnly() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(input))
      return reject(new Error(`Input not found: ${inputRelative}`));

    // Apply bandpass filter centered at 1700 Hz with width to cover ~300-3400 Hz
    ffmpeg(input)
      .audioFilters("bandpass=f=1700:width_type=h:width=3100")
      .audioCodec("libmp3lame")
      .on("start", (cmd) =>
        console.log(JSON.stringify({ step: 1, action: "bandpass", cmd }))
      )
      .on("error", (err) => reject(err))
      .on("end", () => resolve())
      .save(filtered);
  });
}

(async function main() {
  try {
    console.log(JSON.stringify({ status: "starting", input: inputRelative }));
    await applyBandpassOnly();
    console.log(
      JSON.stringify({ status: "filtered", output: path.basename(filtered) })
    );
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ status: "error", message: String(err) }));
    process.exit(1);
  }
})();
