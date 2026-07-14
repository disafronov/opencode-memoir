import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cache = new Map<string, string>();

/**
 * Load a prompt template from src/prompts (dev / tsx) or dist/prompts (bundled).
 * Cached per file. Templates are plain text with ${TOKEN} placeholders that the
 * caller substitutes. Keeping prompts as standalone files (not TS string
 * literals) makes them easy to read and edit in isolation — mirroring how the
 * upstream memoir plugin keeps hooks/prompts/*.tmpl as first-class artifacts.
 */
export function loadPrompt(file: string): string {
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  const path = fileURLToPath(new URL(`./prompts/${file}`, import.meta.url));
  const text = readFileSync(path, "utf8");
  cache.set(file, text);
  return text;
}
