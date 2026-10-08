// /pm opens a pane inside Claude Code. It shows a live token split of what you
// are typing, this session's prompts, and the numbers for the highlighted one.
// Hooks modules can't load node:fs or WASM. So the session numbers come from
// scripts/pane-data.mjs, run with node, and the token splits come from
// lib/bpe.mjs, a pure-JS copy of the tokenizer.
import { atom, read, update } from 'claude-code'
import { createTokenizer } from '../lib/bpe.mjs'

const PANE = 'prompt-meter'
const ROW = 'row:'
const RANKS = 'vendor/claude-tokenizer.json'
// Token chip backgrounds, cycled. Muted enough for light text on either theme.
const CHIPS = ['#3b5b8c', '#6d4a8c', '#2f7560', '#86672a', '#8c3f55']
const CHIP_TEXT = '#f4f4f4'

// Number of the highlighted prompt. 0 means the newest one.
const selected = atom({ plugin: 'prompt-meter', key: 'selected' }, 0)

let data // pane-data.mjs output: { window, command, contextNow, turns }
let failure // why the last load failed
let tokenizer // undefined until read, null when claude.json is missing
let draft = '' // the prompt box as of its last edit
let shown = false // whether the pane is open, so typing only redraws it then
const splits = new Map() // text → token pieces, for the prompts being redrawn

// ── data ─────────────────────────────────────────────────────────────────────

async function load($, env) {
  try {
    const id = await $.session.id()
    const run = await $.process.run(['node', `${$.plugin.root}/scripts/pane-data.mjs`, id], { env, timeoutMs: 20000 })
    if (run.exitCode !== 0) throw new Error(run.stderr.trim() || `pane-data.mjs exited with ${run.exitCode}`)
    data = JSON.parse(run.stdout)
    failure = undefined
  } catch (error) {
    failure = String(error?.message ?? error)
  }
}

async function loadTokenizer($) {
  if (tokenizer !== undefined) return
  try {
    tokenizer = createTokenizer(JSON.parse(await $.fs.read(`${$.plugin.root}/${RANKS}`)))
  } catch {
    tokenizer = null // vocabulary missing: counts fall back to an estimate
  }
}

// Reloads in the background so the turn it hooks never waits on node.
async function refresh($, env) {
  await load($, env)
  $.ui.invalidate('ui.render')
}

function split(text) {
  if (!tokenizer || !text) return []
  if (!splits.has(text)) {
    if (splits.size > 64) splits.clear()
    splits.set(text, tokenizer.split(text))
  }
  return splits.get(text)
}

function count(text) {
  if (!text) return 0
  if (tokenizer) return split(text).reduce((sum, piece) => sum + piece.tokens, 0)
  const nonAscii = text.match(/[^\x20-\x7e\n\t]/g)?.length ?? 0
  return Math.ceil((text.length - nonAscii) / 4 + nonAscii)
}

// ── formatting ───────────────────────────────────────────────────────────────

function fmt(n) {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${+(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

const signed = n => (n >= 0 ? '+' : '-') + fmt(Math.abs(n))
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const visible = s => s.replaceAll(' ', '␣').replaceAll('\n', '↵').replaceAll('\t', '⇥')

function pct(fraction) {
  const p = fraction * 100
  if (p === 0) return '0%'
  if (Math.abs(p) >= 10) return `${p.toFixed(1)}%`
  if (Math.abs(p) >= 1) return `${p.toFixed(2)}%`
  return `${+p.toPrecision(2)}%`
}

// Green under half a percent of the window, yellow under 2%, red above; muted
// when the context shrank (compaction).
const growthColor = fraction => (fraction < 0 ? 'subtle' : fraction < 0.005 ? 'success' : fraction < 0.02 ? 'warning' : 'error')

function clip(text, width) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > width ? flat.slice(0, Math.max(width - 1, 0)) + '…' : flat.padEnd(width)
}

function wrapLines(text, width, max) {
  const out = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (line) out.push(line)
        line = ''
        out.push(word.slice(0, width))
        word = word.slice(width)
      }
      if (line && line.length + 1 + word.length > width) {
        out.push(line)
        line = word
      } else {
        line = line ? `${line} ${word}` : word
      }
    }
    if (line) out.push(line)
  }
  if (out.length > max) {
    out.length = max
    out[max - 1] = out[max - 1].slice(0, width - 1) + '…'
  }
  return out
}

// ── drawing ──────────────────────────────────────────────────────────────────

// ▕████▓▓░░░░▏ as colored runs: context before, added, free.
function gauge(Text, before, after, window, width) {
  const cell = n => Math.min(width, Math.max(0, Math.round((n / window) * width)))
  const b = cell(before)
  const a = Math.max(b, cell(after))
  return [
    h(Text, { color: 'suggestion' }, '█'.repeat(b)),
    h(Text, { color: 'warning' }, '█'.repeat(a - b)),
    h(Text, { color: 'subtle' }, '░'.repeat(width - a)),
  ]
}

// Lays the token pieces out as colored chips, at most maxRows rows of width
// cells. What doesn't fit becomes "+N more" at the end of the last row.
function chipRows(Text, pieces, width, maxRows) {
  const rows = [[]]
  let used = 0
  let hidden = 0
  pieces.forEach((piece, i) => {
    if (hidden) {
      hidden += piece.tokens
      return
    }
    let label = visible(piece.text) + (piece.tokens > 1 ? `×${piece.tokens}` : '')
    if (label.length > width) label = label.slice(0, width - 1) + '…'
    if (used + label.length > width) {
      if (rows.length === maxRows) {
        hidden += piece.tokens
        return
      }
      rows.push([])
      used = 0
    }
    rows.at(-1).push({ label, color: CHIPS[i % CHIPS.length], tokens: piece.tokens })
    used += label.length
  })
  if (hidden) {
    const last = rows.at(-1)
    while (last.length && used + ` +${hidden} more`.length > width) {
      const chip = last.pop()
      hidden += chip.tokens
      used -= chip.label.length
    }
  }
  return rows.map((row, r) =>
    h(
      Text,
      { wrap: 'truncate-end' },
      ...row.map(chip => h(Text, { backgroundColor: chip.color, color: CHIP_TEXT }, chip.label)),
      ...(hidden && r === rows.length - 1 ? [h(Text, { color: 'subtle' }, ` +${hidden} more`)] : []),
    ),
  )
}

// Keeps the lines that fit in budget rows, dropping the highest ranks first.
// Rank 0 always stays.
function fit(lines, budget) {
  const order = lines
    .map((line, i) => i)
    .filter(i => lines[i].rank > 0)
    .sort((a, b) => lines[b].rank - lines[a].rank || b - a)
  const dropped = new Set(order.slice(0, Math.max(0, lines.length - budget)))
  return lines.filter((line, i) => !dropped.has(i)).map(line => line.node)
}

function header(Text, turns, window, wide) {
  const now = data.contextNow
  const input = turns.reduce((sum, t) => sum + t.usage.input, 0)
  const output = turns.reduce((sum, t) => sum + t.usage.output, 0)
  return h(
    Text,
    { wrap: 'truncate-end' },
    h(Text, { bold: true, color: 'claude' }, '◆ prompt-meter'),
    h(Text, { color: 'subtle' }, `  ${plural(turns.length, 'prompt')} · ${wide ? 'context ' : ''}`),
    h(Text, { bold: true }, fmt(now)),
    h(Text, { color: 'subtle' }, ` / ${fmt(window)} `),
    ...gauge(Text, now, now, window, wide ? 20 : 10),
    h(Text, null, ` ${pct(now / window)}`),
    ...(wide ? [h(Text, { color: 'subtle' }, `   ·   ${fmt(input)} in · ${fmt(output)} out this session`)] : []),
  )
}

// The prompt box, split as you type. Always 1 + chipRowCount rows tall, so the
// pane doesn't jump while you type.
function live(Text, width, chipRowCount, isFocused, window) {
  const wide = width >= 100
  const tokens = count(draft)
  const now = data?.contextNow ?? 0
  const lines = [
    h(
      Text,
      { wrap: 'truncate-end' },
      h(Text, { bold: true, color: 'suggestion' }, '✎ typing   '),
      ...(draft
        ? [
            h(Text, { bold: true }, plural(tokens, 'token')),
            h(Text, { color: 'subtle' }, ` · ${[...draft].length} chars   ${wide ? 'if sent: context ' : 'ctx '}`),
            h(Text, { bold: true, color: growthColor(tokens / window) }, `+${fmt(tokens)}`),
            h(Text, { color: 'subtle' }, ` → ${fmt(now + tokens)}${wide ? ` = ${pct((now + tokens) / window)} of ${fmt(window)}` : ''}`),
            ...(tokenizer ? [] : [h(Text, { color: 'warning' }, '   estimate: vendor/claude-tokenizer.json is missing')]),
          ]
        : [h(Text, { color: 'subtle' }, isFocused ? 'esc, then type: tokens show here as you type' : 'type a prompt: tokens show here as you type')]),
    ),
    ...chipRows(Text, split(draft), width, chipRowCount),
  ]
  while (lines.length < 1 + chipRowCount) lines.push(h(Text, null, ' '))
  return lines
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
// Colors of the parts sent with a prompt; the prompt itself is always first.
const PART_COLORS = ['claude', 'suggestion', 'success', 'warning', 'autoAccept', 'planMode', 'permission', 'bashBorder']

// A bar fraction × width cells long, drawn in eighths of a cell and padded to
// width. Anything above zero shows at least a sliver.
function bar(Text, fraction, width, color) {
  const eighths = Math.round(Math.min(1, Math.max(0, fraction)) * width * 8)
  const text = '█'.repeat(Math.floor(eighths / 8)) + (eighths === 0 && fraction > 0 ? '▏' : EIGHTHS[eighths % 8])
  return [h(Text, { color }, text), h(Text, null, ' '.repeat(Math.max(0, width - text.length)))]
}

// One bar of width cells split into colored runs, one per part, by tokens.
// A part too small for a cell still gets one, taken from the largest.
function stackedBar(Text, parts, width) {
  const sizes = parts.map(p => Math.max(0, p.tokens))
  const total = sizes.reduce((sum, n) => sum + n, 0)
  if (!total) return [h(Text, { color: 'subtle' }, '░'.repeat(width))]
  const exact = sizes.map(n => (n / total) * width)
  const cells = exact.map(Math.floor)
  let left = width - cells.reduce((sum, n) => sum + n, 0)
  for (const i of exact.map((x, i) => i).sort((a, b) => (exact[b] % 1) - (exact[a] % 1))) {
    if (left-- <= 0) break
    cells[i]++
  }
  sizes.forEach((n, i) => {
    const biggest = cells.indexOf(Math.max(...cells))
    if (n > 0 && cells[i] === 0 && cells[biggest] > 1) {
      cells[biggest]--
      cells[i]++
    }
  })
  return parts.map((p, i) => h(Text, { color: p.color }, '█'.repeat(cells[i])))
}

// "● label 1.2k ● label 300", largest first, each dot the color of its run
// in the stacked bar beside it.
function legend(Text, parts) {
  return parts
    .filter(p => p.tokens > 0)
    .toSorted((a, b) => b.tokens - a.tokens)
    .flatMap(p => [h(Text, { color: p.color }, ' ● '), h(Text, { color: 'subtle' }, `${p.label} ${fmt(p.tokens)}`)])
}

// "label:        value  bar  legend or note", one row, in fixed columns.
function statRow(Text, layout, { label, value, valueColor, strong, bars, after }) {
  return h(
    Text,
    { wrap: 'truncate-end' },
    h(Text, { bold: strong, color: strong ? undefined : 'subtle' }, `  ${`${label}:`.padEnd(layout.label)}`),
    h(Text, { bold: true, color: valueColor }, value.padStart(layout.value)),
    h(Text, null, '  '),
    ...(bars ?? [h(Text, null, ' '.repeat(layout.bar))]),
    ...(after ?? []),
  )
}

// Rows the details take at most; a stacked layout keeps this much for them.
const DETAIL_ROWS = 21

function details(Text, turn, total, window, width, budget) {
  const lines = []
  const add = (rank, node) => lines.push({ rank, node })
  const blank = rank => add(rank, h(Text, null, ' '))
  const layout = { label: 12, value: 8, bar: 0 }
  layout.bar = Math.min(20, Math.max(6, width - 2 - layout.label - layout.value - 2 - 30))
  const row = (rank, fields) => add(rank, statRow(Text, layout, fields))
  const note = (text, color = 'subtle') => h(Text, { color }, `  ${text}`)
  // A breakdown on its own line, under the bar it explains.
  const legendRow = (rank, parts) =>
    add(rank, h(Text, { wrap: 'truncate-end' }, ' '.repeat(2 + layout.label + layout.value + 1), ...legend(Text, parts)))

  add(0, h(Text, { wrap: 'truncate-end' }, h(Text, { bold: true }, `prompt ${turn.number} of ${total}`), h(Text, { color: 'subtle' }, turn.time ? ` · ${turn.time}` : '')))
  wrapLines(turn.prompt, width - 2, 3).forEach((line, i) => add([3, 7, 8.2][i], h(Text, { color: 'subtle', italic: true }, `│ ${line}`)))
  chipRows(Text, split(turn.prompt), width, 3).forEach((chips, i) => add([2.6, 6.8, 8.1][i], chips))
  blank(9)

  const chars = turn.chars
  row(1, { label: 'prompt', value: fmt(turn.promptTokens), after: [note(`${chars} chars · ${(chars / Math.max(turn.promptTokens, 1)).toFixed(1)} chars/token`)] })
  if (!turn.complete) {
    add(0, h(Text, { color: 'warning' }, '  ◌ still running: the numbers fill in when the turn ends'))
    return fit(lines, budget)
  }

  // What went into the context with the prompt (parts estimated, total
  // measured by the API).
  const sentLabel = turn.before === 0 ? 'at start' : 'total sent'
  if (turn.added < 0) {
    row(0, { label: sentLabel, value: signed(turn.added), strong: true, after: [note('context shrank: compacted before this prompt')] })
  } else {
    const parts = turn.parts.map((p, i) => ({ ...p, color: /^(other|system prompt)/.test(p.label) ? 'inactive' : PART_COLORS[i % PART_COLORS.length] }))
    row(0, { label: sentLabel, value: fmt(turn.added), strong: true, bars: stackedBar(Text, parts, layout.bar), after: [note(`${pct(turn.added / window)} of ${fmt(window)}`)] })
    legendRow(4, parts)
  }
  blank(8.5)

  const start = turn.before + turn.prevOutput
  const grew = turn.atEnd - start
  row(4.5, { label: 'before', value: fmt(start), bars: bar(Text, start / window, layout.bar, 'suggestion'), after: [note(`${pct(start / window)} full`)] })
  row(2, {
    label: 'working',
    value: signed(turn.duringTurn),
    valueColor: growthColor(turn.duringTurn / window),
    after: [note(`${plural(turn.usage.calls, 'API call')}${turn.tools ? ` · ${turn.tools}` : ''}`)],
  })
  row(0, {
    label: 'context',
    value: fmt(turn.atEnd),
    strong: true,
    bars: gauge(Text, start, turn.atEnd, window, layout.bar),
    after: [note(`${pct(turn.atEnd / window)} full · `), h(Text, { color: growthColor(grew / window) }, signed(grew)), h(Text, { color: 'subtle' }, ' this turn')],
  })
  blank(8.5)

  // What the API processed: every call re-reads the whole context.
  const u = turn.usage
  const input = [
    { label: 'cache read', tokens: u.cacheRead, color: 'suggestion' },
    { label: 'cache write', tokens: u.cacheWrite, color: 'warning' },
    { label: 'uncached', tokens: u.uncached, color: 'error' },
  ]
  const output = [
    { label: 'thinking', tokens: u.thinking, color: 'autoAccept' },
    { label: 'text & tool calls', tokens: u.output - u.thinking, color: 'success' },
  ]
  row(1.5, { label: 'input', value: fmt(u.input), strong: true, bars: stackedBar(Text, input, layout.bar), after: [note(`${(u.input / window).toFixed(2)}× the window`)] })
  legendRow(5, input)
  row(1.5, { label: 'output', value: fmt(u.output), strong: true, bars: stackedBar(Text, output, layout.bar) })
  legendRow(5.5, output)
  if (turn.subagents) {
    row(6, { label: 'subagents', value: fmt(turn.subagents.input + turn.subagents.output), after: [note('in their own contexts, not yours')] })
  }
  return fit(lines, budget)
}

// ── hooks ────────────────────────────────────────────────────────────────────

export function register(on, options) {
  // The data script reads the same CLAUDE_PLUGIN_OPTION_* variables as the hooks.
  const env = {}
  for (const [key, value] of Object.entries(options ?? {})) env[`CLAUDE_PLUGIN_OPTION_${key}`] = String(value)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pm', description: 'Browse this session\'s prompts and see what you type split into tokens', immediate: true })
    return next(e)
  })

  on('command.run', { command: 'pm' }, async $ => {
    await Promise.all([load($, env), loadTokenizer($)])
    await update($, selected, () => 0)
    draft = ''
    const opened = await $.ui.open({ id: PANE, title: 'prompt-meter', focus: true, rows: 40 })
    return { text: opened.isPlaced ? 'pane open: ↑↓ pick a prompt · esc to type (live tokens) · ctrl+x tab back · q close' : `pane waits: ${opened.reason}` }
  })

  // What you type, for the live split.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    if (box.text !== draft) {
      draft = box.text
      if (shown) $.ui.invalidate('ui.render')
    }
    return box
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    draft = ''
    if (shown) $.ui.invalidate('ui.render')
    return next(e)
  }).catch(($, e, next) => next(e))

  // New numbers when a turn starts (its prompt joins the list) and ends.
  on('turn.start', async ($, e, next) => {
    if (shown) void refresh($, env)
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (shown && e.agentId === undefined) void refresh($, env)
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    shown = false
    return next(e)
  }).catch(($, e, next) => next(e))

  // Moving the highlight (arrows / Tab) onto a row selects that prompt. Past
  // either end of the list it stops, rather than wander onto the footer or the
  // pane's close mark (r, q and Esc still work).
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const number = e.element?.startsWith(ROW) ? Number(e.element.slice(ROW.length)) : undefined
    if (number === undefined && e.origin.kind === 'person') return { deny: 'the list keeps the keys' }
    const moved = await next(e)
    if (moved.deny === undefined && number !== undefined) await update($, selected, () => number)
    return moved
  }).catch(($, e, next) => next(e)) // a failed update must never pin the highlight

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    shown = true
    if (data === undefined && failure === undefined) await load($, env)
    await loadTokenizer($)

    const columns = e.props.bodyColumns
    const rows = e.props.scroll.bodyRows
    const isFocused = e.props.isFocused
    const window = data?.window ?? 1_000_000
    const chipRowCount = rows >= 30 ? 3 : rows >= 18 ? 2 : 1

    const footer = h(
      Box,
      { flexDirection: 'row', gap: 2 },
      // Without the keyboard the arrows walk the prompt box's history instead;
      // say so plainly. A click on the pane doesn't hand it the keys.
      isFocused
        ? h(Text, { color: 'subtle', wrap: 'truncate-end' }, '↑↓ pick · esc to type (pane stays)')
        : h(Text, { color: 'warning', wrap: 'truncate-end' }, 'list inactive: ctrl+x tab or /pm to browse (↑↓ now scroll your prompt history)'),
      h(Button, { key: 'refresh', label: 'refresh', hotkey: 'r', plain: true, onPress: () => refresh($, env) }),
      h(Button, { key: 'close', label: 'close', hotkey: 'q', plain: true, onPress: () => $.ui.close({ id: PANE }) }),
    )
    const top = [h(Box, { key: 'live', flexDirection: 'column' }, ...live(Text, columns, chipRowCount, isFocused, window)), h(Text, { color: 'subtle' }, '─'.repeat(columns))]

    if (failure !== undefined) {
      return h(Box, { flexDirection: 'column' }, ...top, h(Box, { key: 'error' }, h(Text, { color: 'error', wrap: 'wrap' }, `prompt-meter: ${failure}`)), footer)
    }
    const turns = data.turns
    if (!turns.length) {
      return h(Box, { flexDirection: 'column' }, ...top, h(Text, { color: 'subtle' }, 'No prompts in this session yet.'), footer)
    }

    const chosen = await read($, selected)
    const found = turns.findIndex(t => t.number === chosen)
    const index = found === -1 ? turns.length - 1 : found
    const turn = turns[index]

    // header + live + divider + footer, and one row of slack
    const body = Math.max(6, rows - 5 - chipRowCount)
    const wide = columns >= 100
    const listWidth = wide ? Math.min(52, Math.floor(columns * 0.38)) : columns
    const detailWidth = wide ? columns - listWidth - 3 : columns
    // Stacked (a narrow dock): the details keep their rows, the list takes the
    // rest. List block = rows + header + ↑ + ↓ + gap.
    const shownRows = Math.min(turns.length, wide ? Math.max(3, body - 3) : Math.max(3, body - DETAIL_ROWS - 4))
    const detailBudget = wide ? body : Math.max(4, body - shownRows - 4)

    // Every row is drawn, so Tab and the arrows always find the next prompt,
    // even before the pane redraws. Only shownRows of them show: the column
    // slides inside a clipped box to keep the highlight in view, and the pane
    // never overflows (an overflowing pane scrolls on the arrows instead).
    const start = Math.min(Math.max(index - Math.floor(shownRows / 2), 0), Math.max(turns.length - shownRows, 0))
    const numberWidth = String(turns.at(-1).number).length
    const promptWidth = Math.max(8, listWidth - numberWidth - 19)
    const listRows = turns.map(t => {
      const grew = t.complete ? t.atEnd - t.before - t.prevOutput : null
      return h(
        Box,
        { key: `line:${t.number}`, flexDirection: 'row', flexShrink: 0 },
        h(Button, {
          key: `${ROW}${t.number}`,
          plain: true,
          dimColor: isFocused ? undefined : true,
          autoFocus: t === turn ? true : undefined,
          label: `${t === turn ? '▸' : ' '} ${String(t.number).padStart(numberWidth)}  ${clip(t.prompt, promptWidth)}`,
          onPress: () => update($, selected, () => t.number),
        }),
        h(Text, { color: 'suggestion' }, ` ${fmt(t.promptTokens).padStart(6)}`),
        grew === null ? h(Text, { color: 'warning' }, ` ${'…'.padStart(7)}`) : h(Text, { color: growthColor(grew / window) }, ` ${signed(grew).padStart(7)}`),
      )
    })
    const above = start
    const below = turns.length - start - shownRows
    const list = h(
      Box,
      { key: 'list', flexDirection: 'column', width: listWidth, flexShrink: 0 },
      h(Text, { color: 'subtle' }, `${' '.repeat(numberWidth + 4)}${'prompt'.padEnd(promptWidth)} ${'tokens'.padStart(6)} ${'turn Δ'.padStart(7)}`),
      h(Text, { color: 'subtle' }, above ? `  ↑ ${above} more` : ' '),
      h(
        Box,
        { key: 'rows', flexDirection: 'column', height: shownRows, overflow: 'hidden', flexShrink: 0 },
        h(Box, { flexDirection: 'column', marginTop: -start, flexShrink: 0 }, ...listRows),
      ),
      h(Text, { color: 'subtle' }, below ? `  ↓ ${below} more` : ' '),
    )

    return h(
      Box,
      { flexDirection: 'column' },
      header(Text, turns, window, wide),
      ...top,
      h(
        Box,
        { flexDirection: wide ? 'row' : 'column', gap: wide ? 3 : 1 },
        list,
        h(Box, { key: 'details', flexDirection: 'column', flexGrow: 1 }, ...details(Text, turn, turns.length, window, detailWidth, detailBudget)),
      ),
      footer,
    )
  })
}
