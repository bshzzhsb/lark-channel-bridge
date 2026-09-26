import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { PendingQueue } from '../../../src/bot/pending-queue';

afterEach(() => vi.useRealTimers());

describe('PendingQueue', () => {
  it('holds queued replies until overlapping runs have both released the scope', () => {
    vi.useFakeTimers();
    const flushed: string[] = [];
    const queue = new PendingQueue(20, (scope) => flushed.push(scope));
    queue.block('oc_group');
    queue.block('oc_group');
    queue.push('oc_group', {} as NormalizedMessage);

    vi.advanceTimersByTime(100);
    expect(flushed).toEqual([]);
    queue.unblock('oc_group');
    vi.advanceTimersByTime(100);
    expect(flushed).toEqual([]);
    queue.unblock('oc_group');
    vi.advanceTimersByTime(20);
    expect(flushed).toEqual(['oc_group']);
  });
});
