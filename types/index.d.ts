// State the /pm pane keeps per session (hooks/pane.mjs).
declare module 'claude-code' {
  interface PluginState {
    'prompt-meter': {
      /** Number of the highlighted prompt; 0 follows the newest. */
      selected: number
      /** The tab the details show: overview, tokens, context, calls or session. */
      tab: string
    }
  }
}
