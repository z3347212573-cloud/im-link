import { createHash } from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';

export function parseFeishuEvent(event) {
  const message = event?.message;
  if (!message || message.chat_type !== 'p2p' || message.message_type !== 'text') return null;
  let content;
  try { content = JSON.parse(message.content); } catch { return null; }
  if (typeof content.text !== 'string' || !message.message_id || !message.chat_id) return null;
  return { id: message.message_id, chatId: message.chat_id, text: content.text, chatType: 'p2p' };
}

export async function checkFeishuCredentials({ appId, appSecret }) {
  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) throw new Error('飞书凭据校验失败，请检查 App ID、App Secret 和应用状态。');
  return { credentialsValid: true, checkedAt: new Date().toISOString(), message: '接入信息有效。还需验证消息权限、长连接和 Agent 回复。' };
}

export class Feishu {
  constructor(credentials) {
    this.client = new lark.Client({
      appId: credentials.appId, appSecret: credentials.appSecret,
      appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
      logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} },
    });
    // Do not expose SDK request bodies or credentials through console logging.
    this.ws = new lark.WSClient({
      appId: credentials.appId, appSecret: credentials.appSecret,
      domain: lark.Domain.Feishu, logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} },
    });
  }
  async start(onMessage) {
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (event) => {
        const message = parseFeishuEvent(event);
        if (message) await onMessage(message);
      },
    });
    await this.ws.start({ eventDispatcher: dispatcher });
  }
  async send(chatId, text, id) {
    const chunks = [...String(text).matchAll(/[\s\S]{1,3000}/gu)].map((match) => match[0]);
    for (let index = 0; index < chunks.length; index++) {
      const uuid = createHash('sha256').update(id + ':' + index).digest('hex').slice(0, 48);
      const response = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: chunks[index] }), uuid },
      });
      if (response.code !== 0) throw new Error('飞书回复发送失败，请检查消息权限。');
    }
  }
  async close() { this.ws.close({ force: true }); }
}
