#!/usr/bin/env node
// Feeds the /pm pane: prints one session's prompts as JSON.
//   node pane-data.mjs <session-id>
import { contextWindow, findTranscript, readTranscript, turns } from "../lib/meter.mjs";
import { paneTurn } from "../lib/render.mjs";

const path = findTranscript(process.argv[2] ?? "");
const all = path ? turns(readTranscript(path), path) : [];
process.stdout.write(
  JSON.stringify({
    window: contextWindow(),
    command: process.env.CLAUDE_PLUGIN_OPTION_COMMAND || "pm",
    contextNow: all.findLast((t) => t.atEnd !== null)?.atEnd ?? 0,
    turns: all.map(paneTurn),
  }),
);
