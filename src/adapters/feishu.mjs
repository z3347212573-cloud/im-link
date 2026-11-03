import { createHash } from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import { MAX_IMAGE_BYTES, MAX_IMAGES, MediaError, readImage, imageType } from '../core/media.mjs';

export function parseFeishuEvent(event) {
  const message = event?.message;
  if (!message || message.chat_type !== 'p2p' || !['text', 'image', 'post'].includes(message.message_type)) return null;
  let content;
  try { content = JSON.parse(message.content); } catch { return null; }
  if (!content || typeof content !== 'object' || !message.message_id || !message.chat_id) return null;
  let text = '', images = [];
  if (message.message_type === 'text') {
    if (typeof content.text !== 'string') return null;
    text = content.text;
  } else if (message.message_type === 'image') {
    if (typeof content.image_key !== 'string' || !content.image_key) return null;
    images = [{ imageKey: content.image_key }];
  } else {
    const post = Array.isArray(content.content) ? content : content.zh_cn || content.en_us || Object.values(content).find((item) => Array.isArray(item?.content));
    if (!Array.isArray(post?.content)) return null;
    const lines = typeof post.title === 'string' && post.title ? [post.title] : [];
    for (const line of post.content) {
      if (!Array.isArray(line)) continue;
      let part = '';
      for (const block of line) {
        if (block?.tag === 'text' && typeof block.text === 'string') part += block.text;
        if (block?.tag === 'a' && typeof block.href === 'string') part += (block.text || block.href) + ' (' + block.href + ')';
        if (block?.tag === 'img' && typeof block.image_key === 'string' && block.image_key) images.push({ imageKey: block.image_key });
      }
      if (part) lines.push(part);
    }
    text = lines.join('\n');
  }
  if (!text.trim() && !images.length) return null;
  return { id: message.message_id, chatId: message.chat_id, text, chatType: 'p2p', ...(images.length ? { images } : {}) };
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
  constructor(credentials, options = {}) {
    this.client = options.client || new lark.Client({
      appId: credentials.appId, appSecret: credentials.appSecret,
      appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
      logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} },
    });
    // Do not expose SDK request bodies or credentials through console logging.
    this.ws = options.ws || new lark.WSClient({
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
  async downloadImage(messageId, imageKey) {
    let stream, timeout;
    try {
      const resource = await this.client.im.messageResource.get({ path: { message_id: messageId, file_key: imageKey }, params: { type: 'image' } });
      stream = resource.getReadableStream();
      timeout = setTimeout(() => stream.destroy(new MediaError('图片下载超时，请检查网络后重新发送。')), 30000);
      const chunks = []; let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) throw new MediaError('图片超过 5 MB，请缩小图片后重新发送。');
        chunks.push(Buffer.from(chunk));
      }
      const data = Buffer.concat(chunks); imageType(data); return data;
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError('图片下载失败，请检查机器人读取消息资源的权限及网络后重发。');
    } finally { clearTimeout(timeout); stream?.destroy(); }
  }
  async send(chatId, payload, id) {
    const text = typeof payload === 'string' ? payload : payload.text || '';
    const images = typeof payload === 'string' ? [] : payload.images || [];
    if (images.length > MAX_IMAGES) throw new MediaError('一条回复最多支持 4 张图片。');
    // Validate all bytes before sending any part; retry message UUIDs remain stable.
    const files = await Promise.all(images.map((image) => readImage(image.path)));
    const chunks = [...String(text).matchAll(/[\s\S]{1,3000}/gu)].map((match) => match[0]);
    for (let index = 0; index < chunks.length; index++) {
      const uuid = createHash('sha256').update(id + ':' + index).digest('hex').slice(0, 48);
      const response = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: chunks[index] }), uuid },
      });
      if (response.code !== 0) throw new Error('飞书回复发送失败，请检查消息权限。');
    }
    for (let index = 0; index < files.length; index++) {
      const uploaded = await this.client.im.image.create({ data: { image_type: 'message', image: files[index].data } });
      if (!uploaded?.image_key) throw new Error('飞书图片上传失败，请检查图片上传权限。');
      const uuid = createHash('sha256').update(id + ':image:' + index).digest('hex').slice(0, 48);
      const response = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: uploaded.image_key }), uuid },
      });
      if (response.code !== 0) throw new Error('飞书图片发送失败，请检查消息权限。');
    }
  }
  async close() { this.ws.close({ force: true }); }
}
