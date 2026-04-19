// Piper TTS provider — local CPU-based TTS via piper CLI
// Requires: piper binary in PATH, .onnx model files in configured dir

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { SpeechProviderPlugin } from "../../plugins/types.js";
import type { SpeechVoiceOption } from "../provider-types.js";

const execFileAsync = promisify(execFile);

/** Language code prefix → model file name (without directory). */
const LANG_MODEL_MAP: Record<string, string> = {
  fr: "fr_FR-siwis-medium.onnx",
  en: "en_US-amy-medium.onnx",
};

type PiperConfig = { piper: { modelsDir: string; piperBin: string } };

function listModelFiles(modelsDir: string): string[] {
  try {
    if (!existsSync(modelsDir)) {
      return [];
    }
    return readdirSync(modelsDir).filter((f) => f.endsWith(".onnx"));
  } catch {
    return [];
  }
}

function isPiperAvailable(piperBin: string): boolean {
  try {
    execFileSync("which", [piperBin], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function resolveModelForLanguage(modelsDir: string, language?: string): string | undefined {
  const models = listModelFiles(modelsDir);
  if (models.length === 0) {
    return undefined;
  }

  // Try to match by language prefix
  if (language) {
    const langPrefix = language.toLowerCase().split(/[-_]/)[0];
    const mapped = LANG_MODEL_MAP[langPrefix];
    if (mapped && models.includes(mapped)) {
      return path.join(modelsDir, mapped);
    }
    // Fallback: find any model starting with the lang prefix
    const byPrefix = models.find((m) => m.toLowerCase().startsWith(langPrefix));
    if (byPrefix) {
      return path.join(modelsDir, byPrefix);
    }
  }

  // Default: first available model
  return path.join(modelsDir, models[0]);
}

/** Detect language from text using simple heuristics. */
function detectLanguage(text: string): string {
  // French-specific patterns
  const frenchPatterns =
    /\b(je|tu|il|elle|nous|vous|ils|elles|le|la|les|un|une|des|du|de|est|sont|fait|pas|que|qui|dans|pour|avec|sur|mais|ou|et|donc|car|ni|comme|très|bien|merci|bonjour|salut|oui|non|c'est|j'ai|qu'|n'|l'|d'|s'|m'|t')\b/i;
  const frenchCount = (text.match(frenchPatterns) || []).length;

  // English-specific patterns
  const englishPatterns =
    /\b(the|is|are|was|were|have|has|had|will|would|could|should|this|that|these|those|with|from|they|them|their|been|being|what|when|where|which|who|how|not|but|and|for|you|can|all|just|get|got|very|well|hello|yes|no|please|thank)\b/i;
  const englishCount = (text.match(englishPatterns) || []).length;

  if (frenchCount > englishCount) {
    return "fr";
  }
  return "en";
}

export function buildPiperSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "piper",
    label: "Piper (Local)",
    aliases: ["piper-local"],

    isConfigured: ({ config }) => {
      const { piperBin, modelsDir } = (config as unknown as PiperConfig).piper;
      return isPiperAvailable(piperBin) && listModelFiles(modelsDir).length > 0;
    },

    listVoices: async ({ config }) => {
      const { modelsDir } = (config as unknown as PiperConfig).piper;
      const models = listModelFiles(modelsDir);
      return models.map(
        (model): SpeechVoiceOption => ({
          id: model.replace(/\.onnx$/, ""),
          name: model.replace(/\.onnx$/, "").replace(/[-_]/g, " "),
          locale: model.match(/^([a-z]{2}_[A-Z]{2})/)?.[1]?.replace("_", "-"),
        }),
      );
    },

    synthesize: async (req) => {
      const { piperBin, modelsDir } = (req.config as unknown as PiperConfig).piper;
      const language = detectLanguage(req.text);
      const modelPath = resolveModelForLanguage(modelsDir, language);

      if (!modelPath) {
        throw new Error("No Piper model available — check modelsDir configuration");
      }

      const tempRoot = resolvePreferredOpenClawTmpDir();
      mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
      const tempDir = mkdtempSync(path.join(tempRoot, "tts-piper-"));

      const wavPath = path.join(tempDir, "speech.wav");
      const oggPath = path.join(tempDir, "speech.ogg");

      try {
        // Run piper: pipe text via stdin → WAV output file
        await new Promise<void>((resolve, reject) => {
          const proc = execFile(
            piperBin,
            ["--model", modelPath, "--output_file", wavPath],
            { timeout: req.config.timeoutMs || 30_000, maxBuffer: 10 * 1024 * 1024 },
            (err) => {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            },
          );
          proc.stdin?.write(req.text);
          proc.stdin?.end();
        });

        // Convert WAV → OGG/Opus for voice notes (compact, compatible with Telegram/WhatsApp)
        if (req.target === "voice-note") {
          await execFileAsync(
            "ffmpeg",
            [
              "-y",
              "-i",
              wavPath,
              "-c:a",
              "libopus",
              "-b:a",
              "32k",
              "-ar",
              "16000",
              "-ac",
              "1",
              oggPath,
            ],
            { timeout: 30_000 },
          );

          const audioBuffer = readFileSync(oggPath);
          return {
            audioBuffer,
            outputFormat: "opus",
            fileExtension: ".ogg",
            voiceCompatible: true,
          };
        }

        // For non-voice-note targets, return WAV directly
        const audioBuffer = readFileSync(wavPath);
        return {
          audioBuffer,
          outputFormat: "wav",
          fileExtension: ".wav",
          voiceCompatible: false,
        };
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  };
}
