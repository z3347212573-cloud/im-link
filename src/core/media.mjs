import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, atomicWrite } from './files.mjs';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 4;
export const IMAGE_REPLY_GUIDE = '接线台支持回传图片。如需发送图片，请将图片保存在当前工作目录内，并在最终回复中使用 Markdown 图片语法 ![说明](本机图片路径)。支持 PNG、JPEG、GIF、WebP，每张不超过 5 MB，每次最多 4 张。不要只输出文件路径，也不要将普通网页链接当作本机图片。';

export class MediaError extends Error {
  constructor(message) { super(message); this.userMessage = message; }
}
export function imageType(bytes) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new MediaError('图片为空或超过 5 MB，请缩小图片后重新发送。');
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new MediaError('图片格式不受支持或文件已损坏，请使用 PNG、JPEG、GIF 或 WebP。');
}
export const imageExtension = (type) => ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' })[type];

export async function readImage(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new MediaError('图片不是普通文件或超过 5 MB，请更换图片。');
    const buffer = Buffer.alloc(Math.min(MAX_IMAGE_BYTES + 1, stat.size + 1));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const data = buffer.subarray(0, size);
    return { data, mimeType: imageType(data) };
  } finally { await handle.close(); }
}
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

// Only queue-owned copies survive a delivery failure. Agent task execution is never retried.
export class ImageStore {
  constructor(root, cwd) { this.root = path.resolve(root); this.cwd = path.resolve(cwd || process.cwd()); }
  jobRoot(id) { return path.join(this.root, hash(id)); }
  async save(id, key, bytes) {
    const data = Buffer.from(bytes), mimeType = imageType(data);
    const file = path.join(this.jobRoot(id), hash(key) + imageExtension(mimeType));
    await atomicWrite(file, data);
    return { path: file, mimeType };
  }
  async input(job, transport) {
    const refs = job.images || [];
    if (refs.length > MAX_IMAGES) throw new MediaError('一条消息最多支持 4 张图片，请分开发送。');
    const images = [];
    for (const ref of refs) {
      if (typeof ref.imageKey !== 'string' || !ref.imageKey) throw new MediaError('没有读取到图片标识，请重新发送原图。');
      const data = await transport.downloadImage(job.id, ref.imageKey);
      images.push(await this.save(job.id, 'input:' + ref.imageKey, data));
    }
    return { text: job.text, images };
  }
  async output(result, id) {
    const reply = typeof result === 'string' ? { text: result } : result || {};
    let text = typeof reply.text === 'string' ? reply.text : '';
    const candidates = [...(reply.images || [])];
    const matches = [...text.matchAll(/!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\n]+)\s*\)/g)];
    for (const match of matches) {
      let target = match[2].trim();
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
      else target = target.replace(/\s+["'][^"']*["']$/, '');
      if (/^(?:https?:|data:)/i.test(target)) continue;
      if (!/\.(?:png|jpe?g|gif|webp)$/i.test(target)) continue;
      candidates.push({ path: target });
      text = text.replace(match[0], match[1] || '');
    }
    if (!candidates.length) return text;
    if (candidates.length > MAX_IMAGES) throw new MediaError('Agent 回复包含超过 4 张图片，请要求它分批发送。');
    const images = [], seen = new Set();
    for (const candidate of candidates) {
      let data;
      if (candidate.data) {
        if (candidate.data.length > MAX_IMAGE_BYTES) throw new MediaError('图片超过 5 MB，请缩小图片后重新发送。');
        data = Buffer.from(candidate.data);
      }
      else {
        const input = String(candidate.path || '');
        if (!input || (/^[a-z][a-z0-9+.-]*:/i.test(input) && !path.isAbsolute(input) && !input.startsWith('file:'))) throw new MediaError('Agent 返回了无效图片位置，请让它把图片保存到当前工作目录。');
        let real;
        try { real = await fs.realpath(input.startsWith('file:') ? fileURLToPath(input) : path.resolve(this.cwd, input)); }
        catch { throw new MediaError('Agent 返回的图片文件不存在，请让它重新生成并发送。'); }
        const workspace = await fs.realpath(this.cwd);
        const media = await fs.realpath(this.root).catch(() => this.root);
        if (!inside(workspace, real) && !inside(media, real)) throw new MediaError('图片位于当前工作目录之外，请让 Agent 将图片另存到工作目录后重发。');
        ({ data } = await readImage(real));
      }
      const digest = hash(data);
      if (seen.has(digest)) continue;
      seen.add(digest);
      images.push(await this.save(id, 'output:' + digest, data));
    }
    return { text: text.trim(), images };
  }
  async cleanup(id) {
    const file = this.jobRoot(id);
    if (!inside(this.root, file) || file === this.root) throw new Error('Invalid image cache path');
    await fs.rm(file, { recursive: true, force: true });
  }
}
