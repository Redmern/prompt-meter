#!/usr/bin/env node
// Stop hook: once Claude finishes, reports what the turn actually cost, using
// the token usage Claude Code recorded for each API call in the transcript.
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { findTranscript, readTranscript, turns } from "../lib/meter.mjs";
import { turnReport } from "../lib/render.mjs";

const event = JSON.parse(readFileSync(0, "utf8"));
event.transcript_path ??= findTranscript(event.session_id ?? "");

if (["false", "0"].includes(process.env.CLAUDE_PLUGIN_OPTION_SHOW_AFTER_TURN)) process.exit(0);

let turn;
for (let attempt = 0; attempt < 3; attempt++) {
  turn = turns(readTranscript(event.transcript_path), event.transcript_path).at(-1);
  if (turn?.complete) break;
  // The final reply can land in the transcript a moment after Stop fires.
  await sleep(200);
}

if (turn) process.stdout.write(JSON.stringify({ systemMessage: turnReport(turn) }));
