import { afterEach, describe, expect, it } from 'vitest';

import { join } from 'node:path';

import { existingRootTopicScope, policyThreadId, rootTopicScope } from '@/bot/topic-scope';
import { SessionStore } from '@/session/store';

import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const temp: TmpProfile[] = [];
afterEach(async () => { await Promise.all(temp.splice(0).map((item) => item.cleanup())); });

describe('bot-created topic scope', () => {
  it('keeps the root alias across reloads and session resets', async () => {
    const tmp = await createTmpProfile('topic-scope-');
    temp.push(tmp);
    const path = join(tmp.profile, 'sessions.json');
    const scope = rootTopicScope('oc_chat', 'om_root');
    const sessions = new SessionStore(path);
    sessions.markTopicRoot(scope);
    await sessions.flush();

    const loaded = new SessionStore(path);
    await loaded.load();
    expect(existingRootTopicScope({ chatId: 'oc_chat', rootId: 'om_root', sessions: loaded })).toBe(scope);
    expect(policyThreadId(scope, 'oc_chat', 'omt_actual')).toBe('root:om_root');
    loaded.clear(scope);
    await loaded.flush();

    const reset = new SessionStore(path);
    await reset.load();
    expect(existingRootTopicScope({ chatId: 'oc_chat', rootId: 'om_root', sessions: reset })).toBe(scope);
    expect(existingRootTopicScope({ chatId: 'oc_chat', rootId: 'om_other', sessions: reset })).toBeUndefined();
  });
});
