import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MODEL,
  isDefaultModel,
  modelLabel,
  normalizeModelSelection,
  resolveModelArg,
} from '@/agent/models.js';

describe('model selection', () => {
  it('treats unset and the default sentinel as "use agent default"', () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel('')).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL)).toBe(true);
    expect(isDefaultModel('   ')).toBe(true);
    expect(isDefaultModel('claude-opus-4-8')).toBe(false);
  });

  it('accepts arbitrary model names and aliases for either agent', () => {
    expect(normalizeModelSelection('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeModelSelection('codex', 'gpt-6-sol')).toBe('gpt-6-sol');
    expect(normalizeModelSelection('claude', 'my-gateway/custom-model')).toBe('my-gateway/custom-model');
    expect(normalizeModelSelection('codex', '  gpt-6-sol  ')).toBe('gpt-6-sol');
    expect(normalizeModelSelection('claude', undefined)).toBe(DEFAULT_MODEL);
  });

  it('passes a custom model argument and omits the flag for the default', () => {
    expect(resolveModelArg('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelArg('codex', 'custom-provider/model-v2')).toBe('custom-provider/model-v2');
    expect(resolveModelArg('claude', DEFAULT_MODEL)).toBeUndefined();
    expect(resolveModelArg('claude', undefined)).toBeUndefined();
  });

  it('shows the selected model name directly in the saved-config summary', () => {
    expect(modelLabel('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(modelLabel('codex', 'custom-provider/model-v2')).toBe('custom-provider/model-v2');
    expect(modelLabel('claude', DEFAULT_MODEL)).toContain('跟随 CLI 默认');
  });
});
