import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { AgentHost } from '../runtime/host.mjs';

export const name = 'im-link-agent';
export const inject = ['agents', 'agentDefaultModel'];

export class DshDriver {
  constructor(ctx, profile, cwd, api) {
    Object.assign(this, { ctx, profile, cwd, api });
    this.handles = new Map();
    this.askers = new Map();
  }
  async run({ text, session, onSession, ask }) {
    this.askers.set(session.id, ask);
    let handle = this.handles.get(session.id);
    if (!handle) {
      const selection = this.ctx.agentDefaultModel.currentSelection();
      const setup = async (agentCtx) => {
        this.api.installModelSelection(agentCtx, { current: selection, assembled: undefined });
        const presets = this.ctx.get('agentPresets');
        if (presets) await presets.mount(agentCtx, 'standard');
        agentCtx.on('approval/request', async (request) => {
          const currentAsk = this.askers.get(request.agent.id);
          if (!currentAsk) return 'unavailable';
          let reply;
          do { reply = (await currentAsk('需要确认操作：' + request.toolName + '\n' + (request.reason || '') + '\n回复“允许”或“拒绝”。', request.signal)).trim(); }
          while (!/^(允许|拒绝|yes|no|allow|deny)$/i.test(reply));
          return /^(允许|yes|allow)$/i.test(reply) ? 'allowed-once' : 'rejected';
        });
        agentCtx.on('user-questions/request', async (request) => {
          const currentAsk = this.askers.get(request.agent?.id || session.id);
          if (!currentAsk) throw new Error('没有对应的 IM 会话。');
          const answers = [];
          for (const question of request.questions) {
            const options = question.options || [];
            const reply = await currentAsk(question.question + '\n' + (question.detail || '') + '\n' +
              options.map((item, index) => String(index + 1) + '. ' + item.label).join('\n') +
              '\n请回复选项编号或直接输入答案。', request.signal);
            const indexes = reply.trim().split(/[,，\s]+/).map((item) => Number(item) - 1);
            const selected = indexes.length && indexes.every((index) => Number.isInteger(index) && options[index])
              ? indexes.map((index) => options[index].label) : options.filter((item) => item.label === reply.trim()).map((item) => item.label);
            answers.push({ id: question.id, selected, ...(selected.length ? {} : { custom: reply }) });
          }
          return { answers };
        });
      };
      const agentOptions = { provider: selection.provider, model: selection.model };
      handle = session.fresh
        ? await this.ctx.agents.create({ sessionId: session.id, meta: { cwd: this.cwd || process.cwd(), agentPreset: 'standard' }, agentOptions, setup })
        : await this.ctx.agents.resume({ resumeSessionId: session.id, agentOptions, setup });
      this.handles.set(session.id, handle);
      const registry = this.ctx.get('workspaceRegistry');
      const cwd = handle.agent.session.header?.cwd;
      if (registry && cwd) {
        const workspace = await registry.resolveByPath(cwd) || await registry.create(cwd);
        await workspace.attachSession(handle.agent.id);
      }
    }
    const agent = handle.agent;
    await onSession(agent.id);
    const before = agent.session.seq;
    agent.followup(this.api.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    await agent.whenIdle();
    const events = agent.session.snapshotEvents(before);
    for (const event of [...events].reverse()) {
      if (event.type !== 'assistant/message') continue;
      const result = event.data?.message?.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      if (result) return result;
    }
    throw new Error('Agent 没有产生可发送的文字回复。');
  }
  async releaseSession(id) {
    const handle = this.handles.get(id);
    if (handle) { await handle.dispose(); this.handles.delete(id); this.askers.delete(id); }
  }
  async close() { for (const id of [...this.handles.keys()]) await this.releaseSession(id); }
}

export function apply(ctx, config) {
  let host;
  let disposed = false;
  ctx.on('ready', () => {
    void (async () => {
    try {
      const require = createRequire(path.join(config.profileRoot, 'package.json'));
      const llm = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
      const agent = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-agent')).href);
      if (disposed) return;
      host = new AgentHost(config.home, config.profileId, async (profile, cwd) => new DshDriver(ctx, profile, cwd, {
        createUserMessage: llm.createUserMessage, installModelSelection: agent.installModelSelection,
      }));
      await host.start();
    } catch { ctx.logger?.warn('IM Link 渠道组件启动失败，请在管理工具中检查配置。'); }
    })();
  });
  ctx.on('dispose', async () => { disposed = true; await host?.close(); });
}
