import { type CodexFinishReason, CodexJsonlTranslator } from '@/agent/codex/jsonl';
import type { AgentEvent } from '@/agent/types';

import { withTraeLoginHint } from './diagnostics';

/** TRAE 2.0's compatible thread/turn/item envelope, with separate diagnostics. */
export class TraeJsonlTranslator extends CodexJsonlTranslator {
  constructor() { super('traecli'); }

  override translate(raw: unknown): AgentEvent[] {
    if (this.terminalEmitted()) return [];
    if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'item.completed' && 'item' in raw) {
      const item = raw.item;
      if (item && typeof item === 'object' && 'type' in item && item.type === 'reasoning' && 'text' in item && typeof item.text === 'string') {
        return [{ type: 'thinking', delta: item.text }];
      }
    }
    return super.translate(raw).map((event) => event.type === 'error'
      ? { ...event, message: withTraeLoginHint(event.message) } : event);
  }

  override fail(message: string): AgentEvent[] {
    return super.fail(withTraeLoginHint(message));
  }

  override finish(reason?: CodexFinishReason): AgentEvent[] {
    return super.finish(reason).map((event) => event.type === 'error'
      ? { ...event, message: withTraeLoginHint(event.message) } : event);
  }
}
