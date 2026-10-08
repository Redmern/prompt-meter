import { expect, test } from 'claude-code/testing'

const PANE = 'prompt-meter'
const PROPS = (bodyColumns: number, bodyRows = 30) =>
  ({
    title: 'prompt-meter',
    isFocused: true,
    bodyColumns,
    placement: 'inline',
    scroll: { offset: 0, bodyRows },
    view: {},
  }) as const

const usage = { calls: 2, uncached: 4, cacheRead: 9000, cacheWrite: 1000, output: 300, thinking: 100, input: 10004 }
const turn = (number: number, prompt: string, complete = true) => ({
  number,
  time: `10:0${number}`,
  prompt,
  promptTokens: number * 3,
  chars: prompt.length,
  complete,
  before: complete ? number * 10000 : 0,
  prevOutput: 100,
  atStart: complete ? number * 10000 + 400 : null,
  atEnd: complete ? number * 10000 + 2000 : null,
  added: complete ? 300 : null,
  duringTurn: complete ? 1600 : null,
  parts: complete ? [{ label: 'prompt', tokens: number * 3 }] : [],
  usage: complete ? usage : { ...usage, calls: 0 },
  subagents: null,
  tools: complete ? 'Bash ×2, Read' : '',
})

const DATA = {
  window: 1_000_000,
  command: 'pm',
  contextNow: 22000,
  turns: [turn(1, 'first prompt'), turn(2, 'second prompt'), turn(3, 'third prompt', false)],
}

// A tiny claude.json: every byte is a token, and "hi" merges into one.
const RANKS = JSON.stringify({
  pat_str: "'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^\\s\\p{L}\\p{N}]+|\\s+(?!\\S)|\\s+",
  special_tokens: {},
  bpe_ranks: `! 0 ${Array.from({ length: 256 }, (_, i) => btoa(String.fromCharCode(i))).join(' ')}\n! 256 ${btoa('hi')}`,
})

// Answers the calls the pane makes of the engine: the session id, the node run
// of scripts/pane-data.mjs, the tokenizer's ranks, and the open.
function engine(on: any, { data = DATA as unknown, exitCode = 0, opened = [] as string[] } = {}) {
  const runs: string[][] = []
  on('session.id', () => ({ value: 'session-1' }))
  on('process.run', ($: unknown, e: { argv: string[] }) => {
    runs.push([...e.argv])
    return { value: { exitCode, stdout: exitCode ? '' : JSON.stringify(data), stderr: exitCode ? 'boom' : '' } }
  })
  on('fs.read', () => ({ value: RANKS }))
  on('ui.open', ($: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  return runs
}

const mount = ($: any, surface: 'terminal' | 'desktop' = 'terminal', columns = 140, rows = 30) =>
  $.ui.mount({ plugin: 'prompt-meter', surface, component: 'Pane', requestId: PANE, props: PROPS(columns, rows) })

test('/pm loads the session and opens the pane', async ($, on) => {
  const opened: string[] = []
  const runs = engine(on, { opened })
  const ran = await $.command.run({
    command: 'pm',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 140 },
  })
  expect(ran.text).toContain('pane open')
  expect(opened).toEqual([PANE])
  expect(runs).toHaveLength(1)
  expect(runs[0][0]).toBe('node')
  expect(runs[0][1]).toMatch(/scripts\/pane-data\.mjs$/)
  expect(runs[0][2]).toBe('session-1')
})

test('the newest prompt shows first; pressing a row shows that one', async ($, on) => {
  engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const [columns, rows] of [[140, 30], [80, 30], [140, 14]]) {
      const ui = await mount($, surface, columns, rows)
      await ui.press({ key: 'refresh' })
      expect((await ui.find({ key: 'details' }))?.text).toContain('prompt 3 of 3')
      expect((await ui.find({ key: 'details' }))?.text).toContain('still running')
      await ui.press({ key: 'row:1' })
      const details = (await ui.find({ key: 'details' }))?.text
      expect(details).toContain('prompt 1 of 3')
      expect(details).toContain('+1.9k') // context grew 10.1k → 12k over the turn
      expect(details).toContain('10k') // input tokens
      await ui.press({ key: 'row:3' })
      await ui.unmount()
    }
  }
})

test('the prompt is split into colored token chips', async ($, on) => {
  engine(on, { data: { ...DATA, turns: [turn(1, 'hi hi')] } })
  const ui = await mount($)
  await ui.press({ key: 'refresh' })
  // "hi" merges into one token; " hi" splits into " " + "hi".
  expect((await ui.find({ key: 'details' }))?.text).toContain('hi␣hi')
  await ui.unmount()
})

test('moving the highlight onto a row shows its details', async ($, on) => {
  engine(on)
  on('ui.focus', () => ({}))
  const ui = await mount($)
  await ui.press({ key: 'refresh' })
  const moved = await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: 'prompt-meter', element: 'row:2', origin: { kind: 'person' } })
  expect(moved).toEqual({})
  expect((await ui.find({ key: 'details' }))?.text).toContain('second prompt')
  await ui.unmount()
})

test('a failed refresh says why and offers another', async ($, on) => {
  engine(on, { exitCode: 1 })
  const ui = await mount($)
  await ui.press({ key: 'refresh' }) // the module may hold data from an earlier load
  expect((await ui.find({ key: 'error' }))?.text).toContain('boom')
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  await ui.unmount()
})

test('what you type shows split into tokens, live', async ($, on) => {
  engine(on)
  // The editor beneath every hook: applies the splice to the draft.
  on('prompt.edit', ($: unknown, e: { text: string; start: number; end: number; inputText: string }) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length }
  })
  const ui = await mount($)
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ key: 'live' }))?.text).toContain('as you type')

  await $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'hi' })
  await $.prompt.edit({ origin: { kind: 'composer' }, text: 'hi', cursor: 2, start: 2, end: 2, inputText: ' hi!' })
  const live = (await ui.find({ key: 'live' }))?.text
  expect(live).toContain('4 tokens') // hi · ␣ · hi · !
  expect(live).toContain('6 chars')
  expect(live).toContain('hi␣hi!')
  expect(live).toContain('context +4 → 22k') // contextNow 22k, plus 4 tokens

  await $.prompt.submit({ text: 'hi hi!', origin: { kind: 'composer' } } as any).catch(() => {})
  expect((await ui.find({ key: 'live' }))?.text).toContain('as you type')
  await ui.unmount()
})

test('the highlight stays on the list, and every row is there to move to', async ($, on) => {
  const many = { ...DATA, turns: Array.from({ length: 40 }, (_, i) => turn(i + 1, `prompt number ${i + 1}`)) }
  engine(on, { data: many })
  on('ui.focus', () => ({}))
  const ui = await mount($, 'terminal', 140, 20)
  await ui.press({ key: 'refresh' })
  // The newest is highlighted and the list shows only a slice, yet the first
  // and last rows are both drawn, so a fast arrow never runs off the slice.
  expect(await ui.find({ key: 'row:1' })).toBeDefined()
  expect(await ui.find({ key: 'row:40' })).toBeDefined()
  const off = await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: 'prompt-meter', element: 'refresh', origin: { kind: 'person' } })
  expect(off.deny).toBeDefined()
  const closeMark = await $.ui.focus({ component: 'Pane', requestId: PANE, origin: { kind: 'person' } } as any)
  expect(closeMark.deny).toBeDefined()
  await ui.unmount()
})
