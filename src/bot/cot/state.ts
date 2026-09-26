import type { RunState } from '../../card/run-state';

export function finalAnswerOnlyState(state: RunState): RunState {
  return {
    ...state,
    blocks: state.finalText
      ? [{ kind: 'text', content: state.finalText, streaming: false }]
      : state.blocks.filter((b) => b.kind === 'text'),
    reasoning: { content: '', active: false },
    footer: null,
  };
}
