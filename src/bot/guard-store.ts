import { readFile } from 'node:fs/promises';

import { writeFileAtomic } from '@/platform/atomic-write';

export interface GuardSubscription {
  chatId: string;
  userId: string;
  enabled: boolean;
}

interface GuardData {
  subscriptions: GuardSubscription[];
}

/** Only subscriptions survive restarts; reply and progress records are runtime-only. */
export class GuardStore {
  private data: GuardData = { subscriptions: [] };
  private readonly completedMessages = new Set<string>();
  private readonly progressMessages = new Set<string>();
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as GuardData;
      if (!Array.isArray(data.subscriptions)) throw new Error('invalid guard state');

      // Strip legacy scan flags and reply ledgers from existing profile files.
      this.data = { subscriptions: data.subscriptions.map(({ chatId, userId, enabled }) => ({ chatId, userId, enabled })) };
      await this.save();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  get(chatId: string, userId: string): GuardSubscription | undefined {
    return this.data.subscriptions.find((s) => s.chatId === chatId && s.userId === userId);
  }

  enabled(chatId: string): string[] {
    return this.data.subscriptions.filter((s) => s.chatId === chatId && s.enabled).map((s) => s.userId);
  }

  /** Returns true only when this call switches guard from disabled to enabled. */
  async enable(chatId: string, userId: string): Promise<boolean> {
    let entry = this.get(chatId, userId);
    const changed = !entry?.enabled;

    if (!entry) {
      entry = { chatId, userId, enabled: true };
      this.data.subscriptions.push(entry);
    }

    entry.enabled = true;
    await this.save();

    return changed;
  }

  async disable(chatId: string, userId: string): Promise<void> {
    const entry = this.get(chatId, userId);
    if (entry) entry.enabled = false;

    await this.save();
  }

  completed(chatId: string, messageId: string): boolean {
    return this.completedMessages.has(JSON.stringify([chatId, messageId]));
  }

  complete(chatId: string, messageId: string): void {
    this.completedMessages.add(JSON.stringify([chatId, messageId]));
  }

  isProgress(messageId: string): boolean {
    return this.progressMessages.has(messageId);
  }

  async progress(messageId: string): Promise<void> {
    this.progressMessages.add(messageId);
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    const saving = this.saving.catch(() => {}).then(() => writeFileAtomic(this.path, snapshot));
    this.saving = saving;

    return saving;
  }

  flush(): Promise<void> { return this.saving; }
}
