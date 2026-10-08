// Reads a Claude Code session transcript (JSONL) and splits it into turns, one
// per human prompt, with the token usage Claude Code recorded for each API call.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// Attachments that are shown in the UI or kept as metadata but never sent to
// the model. Everything else with text in it rides along with the prompt.
const UI_ONLY = new Set(["hook_system_message", "hook_success", "hook_error", "hook_non_blocking_error", "hook_cancelled"]);

import { countTokens as estimateTokens } from "./tokens.mjs";

export { estimateTokens };

// The word that opens the in-session browser ("pm", "pm 3", "pm help").
export const command = () => (process.env.CLAUDE_PLUGIN_OPTION_COMMAND || "pm").trim();

// Returns the browser argument ("list", "3", "help", ...) or null when the
// prompt is a normal prompt for Claude.
export function parseCommand(prompt = "") {
  const word = command().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = prompt.trim().match(new RegExp(`^${word}(?:\\s+(\\S+))?$`, "i"));
  const arg = m ? (m[1] ?? "list").toLowerCase() : null;
  return arg && /^(list|ls|last|help|\d+)$/.test(arg) ? arg : null;
}

export function contextWindow() {
  const raw = process.env.CLAUDE_PLUGIN_OPTION_CONTEXT_WINDOW ?? process.env.PROMPT_METER_CONTEXT_WINDOW;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1_000_000;
}

export function fmt(n) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export const signed = (n) => (n >= 0 ? "+" : "-") + fmt(Math.abs(n));

export function readTranscript(path) {
  const entries = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A line can be half-written while Claude Code is still appending to it.
    }
  }
  return entries;
}

// Tokens the model read for one API call: everything in its context window.
export const contextOf = (u) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
  return "";
}

const SLASH_COMMAND = /^\s*<(command-name|local-command-)/;

// Newer transcripts tag typed prompts with origin.kind "human"; slash commands
// and interrupt markers carry no origin. Older transcripts have no origins.
function isHumanPrompt(e, hasOrigins) {
  if (e.type !== "user" || e.isMeta || e.isSidechain || e.isCompactSummary) return false;
  if (hasOrigins) return e.origin?.kind === "human";
  const c = e.message?.content;
  if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) return false;
  const text = textOf(c);
  return Boolean(text) && !SLASH_COMMAND.test(text) && !text.startsWith("[Request interrupted");
}

function attachmentExtra(a) {
  if (!a || UI_ONLY.has(a.type)) return null;
  const text = textOf(a.content) || a.text || (Array.isArray(a.addedLines) ? a.addedLines.join("\n") : "");
  if (!text) return null;
  const label = a.type === "hook_additional_context" ? `${a.hookName ?? a.hookEvent} hook` : a.type.replaceAll("_", " ");
  return { label, tokens: estimateTokens(text) };
}

// One entry per API call. Claude Code writes an assistant line per content
// block, all carrying the same message id and usage, so collapse them.
function apiCalls(entries) {
  const byId = new Map();
  entries.forEach((e, index) => {
    const m = e.message;
    if (e.type !== "assistant" || e.isSidechain || !m?.usage || m.model === "<synthetic>") return;
    const id = m.id ?? e.requestId ?? e.uuid;
    if (!byId.has(id)) byId.set(id, { index, usage: m.usage, model: m.model, timestamp: e.timestamp, tools: [] });
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block?.type === "tool_use") byId.get(id).tools.push(block.name);
    }
  });
  return [...byId.values()].sort((a, b) => a.index - b.index);
}

function sumUsage(calls) {
  const t = { calls: calls.length, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 };
  for (const { usage: u } of calls) {
    t.uncached += u.input_tokens ?? 0;
    t.cacheRead += u.cache_read_input_tokens ?? 0;
    t.cacheWrite += u.cache_creation_input_tokens ?? 0;
    t.output += u.output_tokens ?? 0;
    t.thinking += u.output_tokens_details?.thinking_tokens ?? 0;
  }
  t.input = t.uncached + t.cacheRead + t.cacheWrite;
  return t;
}

// Subagents keep their own transcripts next to the session file. Their tokens
// are spent on your prompt but never enter the main context.
function subagentUsage(transcriptPath, from, to) {
  const dir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
  if (!existsSync(dir)) return null;
  const calls = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    const sub = readTranscript(join(dir, file)).map((e) => ({ ...e, isSidechain: false }));
    calls.push(...apiCalls(sub).filter((c) => c.timestamp >= from && (!to || c.timestamp < to)));
  }
  return calls.length ? sumUsage(calls) : null;
}

// Rewinding to an earlier prompt or editing a sent one starts a new branch,
// but the transcript keeps the abandoned one. Keep only the branch the session
// is on by walking the parent links back from the newest entry (across a
// compaction by its logical parent).
function activeBranch(entries) {
  const indexOf = new Map();
  entries.forEach((e, index) => e.uuid && indexOf.set(e.uuid, index));
  const leaf = entries.findLast((e) => e.uuid && !e.isSidechain);
  if (!leaf) return entries;
  const onBranch = new Set();
  let first = entries.length;
  for (let id = leaf.uuid; id && indexOf.has(id) && !onBranch.has(id); ) {
    onBranch.add(id);
    const index = indexOf.get(id);
    first = Math.min(first, index);
    id = entries[index].parentUuid ?? entries[index].logicalParentUuid;
  }
  // A broken link ends the walk early: keep what comes before it as it was.
  return entries.filter((e, index) => index < first || !e.uuid || e.isSidechain || onBranch.has(e.uuid));
}

export function turns(allEntries, transcriptPath) {
  const entries = activeBranch(allEntries);
  const calls = apiCalls(entries);
  // Browser commands are blocked before they reach Claude, so they are not turns.
  const hasOrigins = entries.some((e) => e.type === "user" && e.origin);
  const prompts = entries.flatMap((e, index) =>
    isHumanPrompt(e, hasOrigins) && parseCommand(textOf(e.message?.content)) === null ? [{ e, index }] : [],
  );

  return prompts.map(({ e, index }, i) => {
    const end = prompts[i + 1]?.index ?? entries.length;
    const prev = calls.filter((c) => c.index < index).at(-1);
    const own = calls.filter((c) => c.index > index && c.index < end);
    const first = own[0];
    const last = own.at(-1);

    // Everything between the previous turn's last API call and this turn's
    // first one went into the context together with the prompt.
    const extras = [];
    for (let j = (prev?.index ?? -1) + 1; j < (first?.index ?? end); j++) {
      const x = entries[j];
      if (x.type === "attachment") {
        const extra = attachmentExtra(x.attachment);
        if (extra) extras.push(extra);
      } else if (
        (x.type === "user" && !x.isSidechain && (x.isMeta || SLASH_COMMAND.test(textOf(x.message?.content)))) ||
        (x.type === "system" && x.subtype === "local_command")
      ) {
        const text = textOf(x.message?.content ?? x.content);
        if (text) extras.push({ label: "slash command output", tokens: estimateTokens(text) });
      }
    }

    const promptText = textOf(e.message?.content);
    const before = prev ? contextOf(prev.usage) : 0;
    const prevOutput = prev?.usage.output_tokens ?? 0;
    const atStart = first ? contextOf(first.usage) : null;
    const atEnd = last ? contextOf(last.usage) + (last.usage.output_tokens ?? 0) : null;

    return {
      number: i + 1,
      prompt: promptText,
      timestamp: e.timestamp,
      promptTokens: estimateTokens(promptText),
      extras,
      before,
      // Growth from the previous call to this turn's first call: the previous
      // reply, this prompt, and every extra that rode along with it.
      added: atStart === null ? null : atStart - before - prevOutput,
      prevOutput,
      atStart,
      atEnd,
      duringTurn: atStart === null ? null : atEnd - atStart,
      usage: sumUsage(own),
      calls: own.map((c) => ({ context: contextOf(c.usage), output: c.usage.output_tokens ?? 0, tools: c.tools })),
      subagents: subagentUsage(transcriptPath, e.timestamp, prompts[i + 1]?.e.timestamp),
      model: last?.model ?? prev?.model,
      complete: Boolean(last),
    };
  });
}

export function findTranscript(sessionId) {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  for (const project of existsSync(root) ? readdirSync(root) : []) {
    const path = join(root, project, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}
