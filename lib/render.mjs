// Text rendering shared by the hooks, the pm browser, and the session report.
import { command, contextWindow, fmt, signed } from "./meter.mjs";
import { renderSplit, splitTokens } from "./tokens.mjs";

function pct(fraction) {
  const p = fraction * 100;
  if (p === 0) return "0%";
  if (Math.abs(p) >= 10) return `${p.toFixed(1)}%`;
  if (Math.abs(p) >= 1) return `${p.toFixed(2)}%`;
  return `${+p.toPrecision(2)}%`;
}

export const percentOfWindow = (tokens) => pct(tokens / contextWindow());

// ▕████▓▓░░░░▏  █ context before · ▓ added · ░ free
export function bar(before, after, width = 40) {
  const w = contextWindow();
  const b = Math.min(width, Math.round((before / w) * width));
  const a = Math.min(width, Math.max(b, Math.round((after / w) * width)));
  return `▕${"█".repeat(b)}${"▓".repeat(a - b)}${"░".repeat(width - a)}▏`;
}

export function usageLine(u) {
  return `${fmt(u.input)} in (${fmt(u.cacheRead)} cache read · ${fmt(u.cacheWrite)} cache write · ${fmt(u.uncached)} uncached) · ${fmt(u.output)} out`;
}

const maxShown = () => Number(process.env.CLAUDE_PLUGIN_OPTION_MAX_TOKENS_SHOWN) || 150;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function splitLines(prompt, promptTokens, max = maxShown()) {
  const pieces = splitTokens(prompt);
  const chars = [...prompt].length;
  const lines = [`${plural(promptTokens, "token")} · ${chars} chars · ${(chars / Math.max(promptTokens, 1)).toFixed(1)} chars/token`];
  lines.push(pieces ? renderSplit(pieces, max) : "estimated at ~4 chars/token: vendor/claude-tokenizer.json is missing.");
  return lines;
}

// Stage 1 + 2: shown the moment the prompt is submitted.
export function promptReport(prompt, promptTokens, contextNow) {
  const [summary, split] = splitLines(prompt, promptTokens);
  const lines = [`prompt-meter ─ your prompt: ${summary}`, `  ${split}`];

  if (contextNow) {
    const after = contextNow + promptTokens;
    lines.push(
      `  context ${fmt(contextNow)} → ~${fmt(after)} (+${fmt(promptTokens)} = +${percentOfWindow(promptTokens)} of window) · ${percentOfWindow(contextNow)} → ${percentOfWindow(after)} of ${fmt(contextWindow())}`,
      `  ${bar(contextNow, after)}`,
    );
  } else {
    lines.push(`  first prompt of the session: the system prompt, tools, and skill list load with it`);
  }

  lines.push(`  split by the public Claude tokenizer (older models); today's count can differ slightly. /pm browses past prompts.`);
  return lines.join("\n");
}

// Breaks the measured growth down into the parts we can see in the
// transcript. The rest is message framing and estimate error, or on the first
// turn, the system prompt and tool definitions.
export function addedParts(turn) {
  const parts = [{ label: "prompt", tokens: turn.promptTokens }];
  const grouped = new Map();
  for (const { label, tokens } of turn.extras) grouped.set(label, (grouped.get(label) ?? 0) + tokens);
  for (const [label, tokens] of grouped) parts.push({ label, tokens });
  const seen = parts.reduce((a, p) => a + p.tokens, 0);
  const rest = turn.added - seen;
  if (rest > 0) parts.push({ label: turn.before === 0 ? "system prompt + tools" : "other", tokens: rest });
  return parts;
}

const addedBreakdown = (turn) => addedParts(turn).map((p) => `${p.label} ~${fmt(p.tokens)}`).join(" · ");

function turnLines(turn) {
  const startOfTurn = turn.before + turn.prevOutput;
  const grew = turn.atEnd - startOfTurn;
  const u = turn.usage;
  const lines = [];

  if (turn.before === 0) {
    lines.push(`  session start  context 0 → ${fmt(turn.atStart)}  (${addedBreakdown(turn)})`);
  } else if (turn.added < 0) {
    lines.push(`  prompt sent    context shrank ${signed(turn.added)}: compacted or cleared before this turn`);
  } else {
    lines.push(`  prompt sent    context ${fmt(startOfTurn)} → ${fmt(turn.atStart)}  ${signed(turn.added)} measured  (${addedBreakdown(turn)})`);
  }

  lines.push(
    `  while working  ${signed(turn.duringTurn)} over ${plural(u.calls, "API call")}: tool calls, tool results, replies`,
    `  context now    ${fmt(turn.atEnd)} / ${fmt(contextWindow())} = ${percentOfWindow(turn.atEnd)}  ·  this turn ${signed(grew)} = ${grew >= 0 ? "+" : ""}${percentOfWindow(grew)} of window`,
    `                 ${bar(startOfTurn, turn.atEnd)}`,
    `  input tokens   ${fmt(u.input)} = ${fmt(u.cacheRead)} cache read + ${fmt(u.cacheWrite)} cache write + ${fmt(u.uncached)} uncached`,
    `                 every call re-sends the whole context: ${plural(u.calls, "call")} read ${(u.input / contextWindow()).toFixed(2)}× the window`,
    `  output tokens  ${fmt(u.output)} = ${fmt(u.thinking)} thinking + ${fmt(u.output - u.thinking)} text & tool calls`,
  );
  if (turn.subagents) lines.push(`  subagents      ${usageLine(turn.subagents)} (own contexts, not in yours)`);
  return lines;
}

// Stage 3: shown once Claude has answered.
export function turnReport(turn) {
  if (!turn.complete) return `prompt-meter · prompt ${turn.number}: no API calls recorded yet`;
  return [`prompt-meter ─ prompt ${turn.number} answered`, ...turnLines(turn)].join("\n");
}

const clip = (s, n) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};

export function sessionTable(all, promptWidth = 38) {
  const cols = [
    ["#", 3, (t) => String(t.number)],
    ["prompt", promptWidth, (t) => clip(t.prompt, promptWidth)],
    ["tokens", 7, (t) => fmt(t.promptTokens)],
    ["sent", 11, (t) => (!t.complete ? "running" : t.before === 0 ? `${fmt(t.atStart)} start` : signed(t.added))],
    ["working", 8, (t) => (t.complete ? signed(t.duringTurn) : "")],
    ["calls", 5, (t) => String(t.usage.calls)],
    ["in", 7, (t) => fmt(t.usage.input)],
    ["out", 6, (t) => fmt(t.usage.output)],
    ["context after", 15, (t) => (t.complete ? `${fmt(t.atEnd)} ${percentOfWindow(t.atEnd)}` : "")],
  ];
  const row = (cells) => cells.map((c, i) => c.padEnd(cols[i][1])).join("  ").trimEnd();
  return [row(cols.map((c) => c[0])), row(cols.map((c) => "─".repeat(c[1]))), ...all.map((t) => row(cols.map((c) => c[2](t))))].join("\n");
}

export function browseList(all) {
  if (!all.length) return "prompt-meter: no prompts in this session yet";
  return [
    `prompt-meter ─ ${plural(all.length, "prompt")} this session · window ${fmt(contextWindow())}`,
    "",
    sessionTable(all, 34),
    "",
    `${command()} <number> for details · ${command()} last · ${command()} help   (never sent to Claude: 0 tokens)`,
  ].join("\n");
}

function wrap(text, width) {
  const out = [];
  for (const line of text.split("\n")) {
    let current = "";
    for (const word of line.split(" ")) {
      if (current && (current + " " + word).length > width) {
        out.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    out.push(current);
  }
  return out;
}

export function toolSummary(tools) {
  if (!tools.length) return "reply";
  const counts = new Map();
  for (const name of tools) {
    const short = name.replace(/^mcp__/, "").replace("__", ":");
    counts.set(short, (counts.get(short) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
}

function callTable(calls) {
  const rows = calls.map((c, i) => `  ${String(i + 1).padEnd(5)} ${fmt(c.context).padEnd(8)} ${fmt(c.output).padEnd(6)} ${toolSummary(c.tools)}`);
  const shown = rows.length > 24 ? [...rows.slice(0, 10), `  … ${rows.length - 20} more calls …`, ...rows.slice(-10)] : rows;
  return [`  call  context  out    tools used`, ...shown];
}

export function browseDetails(turn, count) {
  const time = turn.timestamp ? new Date(turn.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const [summary, split] = splitLines(turn.prompt, turn.promptTokens);
  const promptLines = wrap(turn.prompt, 96);
  const shownPrompt = promptLines.length > 12 ? [...promptLines.slice(0, 12), `… ${promptLines.length - 12} more lines`] : promptLines;

  const lines = [
    `prompt-meter ─ prompt ${turn.number} of ${count}${time ? ` · ${time}` : ""}`,
    "",
    ...shownPrompt.map((l) => `  │ ${l}`),
    "",
    `TOKENS   ${summary}`,
    `  ${split}`,
    "",
  ];

  if (turn.complete) {
    lines.push(`CONTEXT`, ...turnLines(turn), "", `API CALLS`, ...callTable(turn.calls));
  } else {
    lines.push(`still running: no API calls recorded yet`);
  }

  const nav = [turn.number > 1 && `${command()} ${turn.number - 1} ◀ previous`, `${command()} list`, turn.number < count && `next ▶ ${command()} ${turn.number + 1}`];
  lines.push("", nav.filter(Boolean).join("   ·   "));
  return lines.join("\n");
}

// One prompt for the /pm pane as plain numbers; the pane formats and colors
// them, and splits the prompt into tokens itself (lib/bpe.mjs).
export function paneTurn(turn) {
  const tools = turn.calls.flatMap((c) => c.tools);
  return {
    number: turn.number,
    time: turn.timestamp ? new Date(turn.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
    prompt: turn.prompt.slice(0, 3000),
    promptTokens: turn.promptTokens,
    chars: [...turn.prompt].length,
    complete: turn.complete,
    before: turn.before,
    prevOutput: turn.prevOutput,
    atStart: turn.atStart,
    atEnd: turn.atEnd,
    added: turn.added,
    duringTurn: turn.duringTurn,
    parts: turn.complete ? addedParts(turn) : [],
    usage: turn.usage,
    subagents: turn.subagents,
    tools: tools.length ? toolSummary(tools) : "",
    steps: turn.calls,
  };
}

export function browseHelp() {
  const c = command();
  return [
    `prompt-meter browser (typed into the prompt box; never sent to Claude, costs 0 tokens)`,
    `  ${c}             list every prompt this session`,
    `  ${c} <number>    full details for one prompt: text, token split, context change, API calls`,
    `  ${c} last        details for the newest prompt`,
    `  ${c} help        this help`,
    `/pm                the same browser as a pane: ↑↓ pick a prompt, its details show beside the list`,
  ].join("\n");
}
