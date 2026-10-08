# prompt-meter

A token and context-window meter for [Claude Code](https://claude.com/claude-code).
See how each prompt splits into tokens, how much it adds to the context window,
and what every turn cost in input and output tokens, without leaving Claude Code
and without spending tokens on it.

```
◆ prompt-meter  12 prompts · 184.2k / 1M ██░░░░░░░░ 18.4%
✎ typing   23 tokens · 104 chars   ctx +23 → 184.2k
Add␣a␣retry␣with␣exponential␣backoff␣to␣the␣upload␣client
──────────────────────────────────────────────────────────────────
      prompt                                        tokens  turn Δ
  ↑ 6 more
   7  fix the failing date parser test                   7   +9.6k
▸  8  add a retry with backoff to the upload client     12  +31.2k
   9  now write tests for it                             6  +14.8k
  ↓ 3 more

1: overview  2: tokens 12  3: context  4: calls 9  5: session
━━━━━━━━━━━──────────────────────────────────────────────────
prompt 8 of 12 · 14:02
│ add a retry with backoff to the upload client
add␣a␣retry␣with␣backoff␣to␣the␣upload␣client

  prompt:           12                45 chars · 3.8 chars/token
  total sent:      412  ████████████  0.041% of 1M
                        ● other 301 ● UserPromptSubmit hook 64 ● prompt 12

  before:       151.4k  ██            15.1% full
  working:      +30.8k                9 API calls · Read ×4, Edit ×3, Bash ×2
  context:      182.6k  ██▍░░░░░░░░░  18.3% full · +31.2k this turn

  input:         1.52M  ████████████  1.52× the window
                        ● cache read 1.49M ● cache write 31k ● uncached 18
  output:        12.4k  ████████████
                        ● thinking 7.9k ● text & tool calls 4.5k
↑↓ pick · 1-5 tabs · esc to type (pane stays)  r: refresh  q: close
```

## Install

In Claude Code:

```
/plugin marketplace add Redmern/claude-plugins
/plugin install prompt-meter@redmern
```

It comes from the [redmern marketplace](https://github.com/Redmern/claude-plugins),
which also has [prompt-analyzer](https://github.com/Redmern/prompt-analyzer) (`/pa`).

Needs **Node.js 20 or newer** on your `PATH` (the hooks run with `node`) and
Claude Code **2.1.294 or newer** for the `/pm` pane. Nothing to `npm install`.

## What you get

**`/pm`: the prompt pane.** Lists this session's prompts. Pick one, then pick
a tab with its number:

1. **overview**: its text and token chips (`🎉×3` is one character that costs
   3 tokens), what it added to the context, the context before and after, and
   the input and output tokens of the turn.
2. **tokens**: the whole token split, the characters that cost several tokens,
   the longest tokens, and how many are whitespace.
3. **context**: every part that went in with the prompt (the prompt, hook
   output, reminders, the rest) with a bar each, then the context window
   before, while Claude worked, and after.
4. **calls**: each API call of the turn: the context it read, what came in
   before it (the prompt, or tool results), its output and the tools it used.
5. **session**: the whole session: context after each prompt as a sparkline
   (a drop is a compaction), total input and output, subagents, and the
   prompts that stood out.

The tab stays as you move through the prompts.

While the pane is open, whatever you type in the prompt box is split into
tokens live in the **typing** line, with how far it would move the context.

| Key | Does |
| --- | --- |
| `↑` `↓` | pick a prompt |
| `1` … `5` | switch tabs |
| `Esc` | back to the prompt box (the pane stays open and shows what you type) |
| `ctrl+x` `tab` | back into the list (a click doesn't give the pane the keys) |
| `r` | refresh |
| `q` | close |

**On every prompt** (optional): its token split and how it moves the context,
shown only to you.

**After every turn** (optional): what the turn did to the context and how many
input and output tokens it used.

**`pm` typed into the prompt box**: the same browser as plain text, for
terminals where the pane doesn't load: `pm`, `pm 3`, `pm last`, `pm help`.
These never reach Claude, so they cost nothing.

**`node scripts/report.mjs [session-id]`**: a table of every prompt in a
session, from any shell.

## Settings

`/plugin configure prompt-meter@redmern`, or `/plugin` → prompt-meter:

| Option | Default | |
| --- | --- | --- |
| `CONTEXT_WINDOW` | 1000000 | your model's context window, for the % figures (200000 for 200k models) |
| `SHOW_ON_SUBMIT` | on | the token split when you send a prompt |
| `SHOW_AFTER_TURN` | on | the report when Claude finishes |
| `MAX_TOKENS_SHOWN` | 150 | tokens shown in the split before "+N more" |
| `COMMAND` | `pm` | the word that opens the typed browser |

## Where the numbers come from

- **Context, total sent, input and output** are what the API reported for each
  call, as Claude Code records it in the session transcript. They are exact.
- **Prompt tokens and the token split** use Anthropic's public Claude tokenizer.
  It is the tokenizer of older Claude models; current models use a different
  one, so these counts are close but not exact.
- The **parts of total sent** (prompt, hook output, reminders) are tokenizer
  estimates; **other** is the rest of the measured growth: message framing,
  the previous reply's formatting, and estimation error.
- Rewound or edited prompts are left out: only the branch the session is on
  counts.

Nothing the meter shows is sent to Claude: hook messages are display-only, and
`pm` commands are stopped before they reach the model. The plugin reads your
local transcripts and makes no network requests.

## The pane is experimental

`/pm` is built on Claude Code's hooks modules, which are not documented yet and
may change. If the pane doesn't load in your version, everything else (the
messages, `pm`, the report script) still works.

## License

MIT, see [LICENSE](LICENSE). The tokenizer vocabulary in `vendor/` is
Anthropic's, under its own license ([vendor/README.md](vendor/README.md)).
