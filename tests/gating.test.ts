import { expect, test } from 'claude-code/testing'

const PANE = 'prompt-meter'
const PROPS = { title: 'prompt-meter', isFocused: true, bodyColumns: 140, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

// Stands in for the engine. Records which hooks-handlers scripts ran, what was
// logged to the transcript and what was saved in the store.
function engine(on: any, { stored = undefined as unknown } = {}) {
  const calls = { handlers: [] as string[], logs: [] as string[], stored: [] as unknown[], paneOpen: false }
  on('ui.panes', () => ({ value: calls.paneOpen ? [{ id: PANE, title: PANE, isShown: true, isFocused: true, isPlaced: true }] : [] }))
  // The engine's own answer beneath the plugins: no decision.
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.Stop', () => ({}))
  on('session.id', () => ({ value: 'session-1' }))
  on('process.run', ($: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    const script = e.argv[1] ?? ''
    const reply = (out: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '' } })
    if (script.endsWith('prompt-submit.mjs')) {
      calls.handlers.push('prompt-submit')
      const event = JSON.parse(e.init?.stdin ?? '{}')
      return reply(/^pm\b/.test(event.prompt) ? { decision: 'block', reason: 'prompt-meter browser' } : { systemMessage: `split of ${event.prompt}` })
    }
    if (script.endsWith('stop.mjs')) {
      calls.handlers.push('stop')
      return reply({ systemMessage: 'turn report' })
    }
    return reply({ window: 1_000_000, command: 'pm', contextNow: 0, turns: [] })
  })
  on('fs.read', () => ({ deny: 'no vocabulary in this test' }))
  on('store.get', () => ({ value: stored }))
  on('store.set', ($: unknown, e: { value: unknown }) => {
    calls.stored.push(e.value)
    return { value: undefined }
  })
  on('ui.log', ($: unknown, e: { text: string }) => {
    calls.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.close', () => ({ value: undefined }))
  return calls
}

const mount = ($: any) => $.ui.mount({ plugin: 'prompt-meter', surface: 'terminal', component: 'Pane', requestId: PANE, props: PROPS })

test('with the pane closed, prompts and turns pass straight through: no node runs', async ($, on) => {
  const calls = engine(on)
  const result = await $.classic.UserPromptSubmit({ prompt: 'refactor the parser' } as any)
  expect(result.block).toBeUndefined()
  await $.classic.Stop({} as any)
  expect(calls.handlers).toEqual([])
  expect(calls.logs).toEqual([])
})

test('typing the browser word works while the pane is closed', async ($, on) => {
  const calls = engine(on)
  const result = await $.classic.UserPromptSubmit({ prompt: 'pm 2' } as any)
  expect(result.block).toContain('prompt-meter browser')
  expect(calls.handlers).toEqual(['prompt-submit'])
})

test('with the pane open, the per-prompt and per-turn messages run', async ($, on) => {
  const calls = engine(on)
  calls.paneOpen = true
  await $.classic.UserPromptSubmit({ prompt: 'refactor the parser' } as any)
  await $.classic.Stop({} as any)
  expect(calls.handlers).toContain('prompt-submit')
  expect(calls.logs).toContain('split of refactor the parser')
})

test('"on when closed" keeps them running after the pane closes, and is saved', async ($, on) => {
  const calls = engine(on)
  const ui = await mount($)
  await ui.press({ key: 'stay' })
  expect(calls.stored).toEqual([true])

  // The pane is closed (the engine lists no pane), yet the messages run.
  calls.paneOpen = false
  await $.classic.UserPromptSubmit({ prompt: 'refactor the parser' } as any)
  expect(calls.logs).toContain('split of refactor the parser')

  // And off again: back to doing nothing while closed.
  await ui.press({ key: 'stay' })
  expect(calls.stored).toEqual([true, false])
  await ui.unmount()
  calls.handlers.length = 0
  await $.classic.UserPromptSubmit({ prompt: 'refactor the parser' } as any)
  expect(calls.handlers).toEqual([])
})
