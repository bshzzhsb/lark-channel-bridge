import type { TenantBrand } from '../../config/schema';
import type { CotEvent, CotRef } from './types';

const ENDPOINTS: Record<TenantBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

// Bounds every CoT HTTP call. Without it a hung message_cot endpoint pins
// start() — which runs before any agent event is drained and before the
// plain-reply fallback — to undici's ~300s default.
const COT_REQUEST_TIMEOUT_MS = 15_000;

export class CotClient {
  private readonly baseUrl: string;
  private readonly appId: string;
  private readonly appSecret: string;
  private token: string | undefined;
  private tokenExpiresAt = 0;

  constructor(opts: { tenant: TenantBrand; appId: string; appSecret: string }) {
    this.baseUrl = ENDPOINTS[opts.tenant];
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
  }

  async tenantToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.tokenExpiresAt - now > 60_000) return this.token;
    const resp = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      signal: AbortSignal.timeout(COT_REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`tenant token HTTP ${resp.status}`);
    const data = await resp.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`tenant token failed: code=${data.code ?? '?'} msg=${data.msg ?? '<no msg>'}`);
    }
    this.token = data.tenant_access_token;
    const expireSeconds = typeof data.expire === 'number' ? data.expire : 7200;
    this.tokenExpiresAt = now + Math.max(60, expireSeconds - 60) * 1000;
    return this.token;
  }

  async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const token = await this.tenantToken();
    const resp = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(COT_REQUEST_TIMEOUT_MS),
      ...init,
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
    if (!resp.ok) throw new Error(`COT HTTP ${resp.status}`);
    const text = await resp.text();
    if (!text) return {};
    const data = JSON.parse(text) as { code?: number; msg?: string; data?: Record<string, unknown> } & Record<string, unknown>;
    if (data.code !== undefined && data.code !== 0) {
      throw new Error(`COT API failed: code=${data.code} msg=${data.msg ?? '<no msg>'}`);
    }
    return data.data ?? data;
  }

  async create(chatId: string, originMessageId?: string, replyInThread = false): Promise<Record<string, unknown>> {
    // message_cot is addressed to the chat. The origin identifies the
    // message being answered, and reply_in_thread selects topic placement.
    return this.request('/open-apis/im/v1/message_cot?receive_id_type=chat_id', {
      method: 'POST',
      body: JSON.stringify({
        receive_id: chatId,
        ...(originMessageId ? { origin_message_id: originMessageId } : {}),
        reply_in_thread: replyInThread,
      }),
    });
  }

  async update(ref: CotRef, events: readonly CotEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.request('/open-apis/im/v1/message_cot', {
      method: 'PUT',
      body: JSON.stringify({
        cot_id: ref.cotId,
        message_id: ref.messageId,
        events,
      }),
    });
  }

  async complete(ref: CotRef, reason: string): Promise<void> {
    const cotId = encodeURIComponent(ref.cotId);
    const messageId = encodeURIComponent(ref.messageId);
    await this.request(`/open-apis/im/v1/message_cot/complete/${cotId}?message_id=${messageId}&reason=${reason}`, {
      method: 'POST',
      body: '',
    });
  }
}
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
