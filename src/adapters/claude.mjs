import { query } from '@anthropic-ai/claude-agent-sdk';
import { readImage, IMAGE_REPLY_GUIDE } from '../core/media.mjs';

export class ClaudeDriver {
  constructor(profile, cwd) { this.profile = profile; this.cwd = cwd || process.cwd(); this.active = new Set(); }
  async run({ text, images = [], session, onSession, ask }) {
    const env = { ...process.env, IM_LINK_CHILD: '1', CLAUDE_CONFIG_DIR: this.profile.root };
    delete env.CLAUDECODE;
    const options = {
      cwd: this.cwd, settingSources: ['user', 'project', 'local'], env,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: IMAGE_REPLY_GUIDE },
      ...(session.fresh ? { sessionId: session.id } : { resume: session.id }),
      canUseTool: async (name, input, { signal }) => {
        if (name === 'AskUserQuestion') {
          const answers = {};
          for (const question of input.questions || []) {
            const choices = (question.options || []).map((item, i) => String(i + 1) + '. ' + item.label + (item.description ? ' — ' + item.description : '')).join('\n');
            const reply = await ask(question.question + '\n' + choices + '\n请直接回复你的选择或答案。', signal);
            const indexes = reply.trim().split(/[,，\s]+/).map((item) => Number(item) - 1);
            answers[question.question] = indexes.length && indexes.every((index) => Number.isInteger(index) && question.options?.[index])
              ? indexes.map((index) => question.options[index].label).join(', ') : reply;
          }
          return { behavior: 'allow', updatedInput: { ...input, answers } };
        }
        let answer;
        do {
          answer = (await ask('Agent 请求使用 ' + name + '：\n' + JSON.stringify(input, (key, value) => /secret|token|password|api.?key/i.test(key) ? '••••••' : value, 2).slice(0, 1800) + '\n回复“允许”或“拒绝”。', signal)).trim();
        } while (!/^(允许|拒绝|yes|no|allow|deny)$/i.test(answer));
        return /^(允许|yes|allow)$/i.test(answer)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: '用户通过 IM 拒绝了这次操作。' };
      },
    };
    let prompt = text;
    if (images.length) {
      const content = [{ type: 'text', text: text || '请查看并描述这些图片。' }];
      for (const image of images) {
        const { data, mimeType } = await readImage(image.path);
        content.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: data.toString('base64') } });
      }
      content.push({ type: 'text', text: '本轮图片的临时原图（只读，本轮回复投递后会清理；编辑结果请另存到工作目录）：\n' + images.map((image) => image.path).join('\n') });
      prompt = (async function* () { yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: session.id }; })();
    }
    const stream = query({ prompt, options });
    this.active.add(stream);
    let result = '';
    let failed = false;
    try {
      for await (const message of stream) {
        if (message.type === 'system' && message.subtype === 'init') await onSession(message.session_id);
        if (message.type === 'result') {
          failed = message.is_error === true || message.subtype !== 'success';
          if ('result' in message) result = message.result;
        }
      }
      if (failed) throw new Error('Agent 任务未成功完成。');
      return result;
    } finally { this.active.delete(stream); }
  }
  async close() { for (const stream of this.active) stream.close(); }
}
