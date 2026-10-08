#!/usr/bin/env node
// Per-turn token report for a whole session.
//   node report.mjs                 newest session on this machine
//   node report.mjs <session-id>    a specific session
//   node report.mjs <file.jsonl>    a transcript file
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { contextWindow, findTranscript, fmt, readTranscript, signed, turns } from "../lib/meter.mjs";
import { sessionTable, usageLine } from "../lib/render.mjs";

function newestTranscript() {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  let best = null;
  for (const project of existsSync(root) ? readdirSync(root) : []) {
    for (const file of readdirSync(join(root, project))) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(root, project, file);
      const mtime = statSync(path).mtimeMs;
      if (!best || mtime > best.mtime) best = { path, mtime };
    }
  }
  return best?.path;
}

const arg = process.argv[2];
const path = !arg ? newestTranscript() : arg.endsWith(".jsonl") ? arg : findTranscript(arg);
if (!path || !existsSync(path)) {
  console.error(`prompt-meter: no transcript found for ${arg ?? "newest session"}`);
  process.exit(1);
}

const all = turns(readTranscript(path), path).filter((t) => t.complete);
if (!all.length) {
  console.log("prompt-meter: no completed turns in this session yet");
  process.exit(0);
}

console.log(`session ${path}`);
console.log(`model ${all.at(-1).model} · window ${fmt(contextWindow())}\n`);
console.log(sessionTable(all));

const total = all.reduce(
  (a, t) => {
    for (const k of Object.keys(a)) a[k] += t.usage[k];
    return a;
  },
  { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, uncached: 0, output: 0, thinking: 0 },
);
console.log(`\ntotal  ${total.calls} API calls · ${usageLine(total)}`);

const subagents = all.filter((t) => t.subagents);
if (subagents.length) {
  const sub = subagents.reduce((a, t) => a + t.subagents.input + t.subagents.output, 0);
  console.log(`subagents  ${fmt(sub)} tokens across ${subagents.length} turn(s), not counted above`);
}

const later = all.filter((t) => t.before > 0 && t.added >= 0);
const biggestPrompt = later.toSorted((a, b) => b.added - a.added)[0];
const priciest = all.toSorted((a, b) => b.usage.input - a.usage.input)[0];
if (biggestPrompt) console.log(`\nlargest prompt addition  turn ${biggestPrompt.number}: ${signed(biggestPrompt.added)}`);
console.log(`most tokens processed    turn ${priciest.number}: ${fmt(priciest.usage.input)} in over ${priciest.usage.calls} calls`);
