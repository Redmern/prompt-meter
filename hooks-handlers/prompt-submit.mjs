#!/usr/bin/env node
// UserPromptSubmit hook. Two jobs:
//  - "pm", "pm 3", ...: the in-session browser. The prompt is blocked, so it
//    never reaches Claude and costs no tokens; the hook's text is shown instead.
//  - any other prompt: show how it splits into tokens and moves the context.
// systemMessage is shown to the user only, so the meter adds no tokens itself.
import { readFileSync } from "node:fs";
import { contextOf, estimateTokens, findTranscript, parseCommand, readTranscript, turns } from "../lib/meter.mjs";
import { browseDetails, browseHelp, browseList, promptReport } from "../lib/render.mjs";

const event = JSON.parse(readFileSync(0, "utf8"));
const prompt = event.prompt ?? "";
// The hooks module hands the event over; it may carry the session id alone.
event.transcript_path ??= findTranscript(event.session_id ?? "");

function read() {
  try {
    return readTranscript(event.transcript_path);
  } catch {
    return []; // New session: no transcript yet.
  }
}

const arg = parseCommand(prompt);
if (arg !== null) {
  const all = turns(read(), event.transcript_path);
  let text;
  if (arg === "help") text = browseHelp();
  else if (arg === "list" || arg === "ls") text = browseList(all);
  else {
    const n = arg === "last" ? all.length : Number(arg);
    text = all[n - 1] ? browseDetails(all[n - 1], all.length) : `prompt-meter: no prompt ${arg}; this session has ${all.length}.\n\n${browseList(all)}`;
  }
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: text,
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true },
  }));
  process.exit(0);
}

if (["false", "0"].includes(process.env.CLAUDE_PLUGIN_OPTION_SHOW_ON_SUBMIT)) process.exit(0);

let contextNow = 0;
const last = read()
  .filter((e) => e.type === "assistant" && !e.isSidechain && e.message?.usage && e.message.model !== "<synthetic>")
  .at(-1);
if (last) contextNow = contextOf(last.message.usage) + (last.message.usage.output_tokens ?? 0);

process.stdout.write(JSON.stringify({ systemMessage: promptReport(prompt, estimateTokens(prompt), contextNow) }));
