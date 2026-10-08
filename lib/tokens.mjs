// Token splitting with Anthropic's published Claude tokenizer. It is the BPE
// used by Claude 2-era models; Claude 3 and newer use a private tokenizer, so
// counts and boundaries here are close but not exact. The vocabulary ships in
// vendor/ and lib/bpe.mjs runs it, so there is nothing to npm install.
import { readFileSync } from "node:fs";
import { createTokenizer } from "./bpe.mjs";

let tokenizer;
try {
  tokenizer = createTokenizer(JSON.parse(readFileSync(new URL("../vendor/claude-tokenizer.json", import.meta.url), "utf8")));
} catch {
  tokenizer = null; // vocabulary missing: fall back to the 4-chars-per-token rule.
}

export const hasTokenizer = Boolean(tokenizer);

export function countTokens(text = "") {
  if (!text) return 0;
  if (tokenizer) return tokenizer.count(text);
  const nonAscii = text.match(/[^\x20-\x7e\n\t]/g)?.length ?? 0;
  return Math.ceil((text.length - nonAscii) / 4 + nonAscii);
}

// Returns [{ text, tokens }]. Usually one entry per token; a character that is
// split across several byte-level tokens (emoji, accents) becomes one entry
// with tokens > 1 so it can still be shown readably.
export function splitTokens(text = "") {
  if (!tokenizer || !text) return null;
  return tokenizer.split(text);
}

const visible = (s) => s.replaceAll(" ", "␣").replaceAll("\n", "↵").replaceAll("\t", "⇥");

export function renderSplit(pieces, max) {
  const shown = pieces.slice(0, max).map((p) => `[${visible(p.text)}${p.tokens > 1 ? `×${p.tokens}` : ""}]`);
  const rest = pieces.slice(max).reduce((a, p) => a + p.tokens, 0);
  return shown.join("") + (rest ? ` … +${rest} more tokens` : "");
}
