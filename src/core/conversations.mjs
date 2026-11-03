import { randomUUID } from 'node:crypto';
import { clone, hash } from './files.mjs';
import { MediaError } from './media.mjs';

// The queue belongs to the Agent-side adapter, never to the manager window.
export class Conversations {
  constructor({ store, driver, send, revision, canStart = async () => true, activity = () => {}, failure = () => {}, prepareInput = async (job) => ({ text: job.text, images: job.images || [] }), prepareResult = async (result) => result, cleanup = async () => {} }) {
    Object.assign(this, { store, driver, send, revision, canStart, activity, failure, prepareInput, prepareResult, cleanup });
    this.workers = new Map();
    this.questions = new Map();
    this.incoming = new Map();
    this.stopped = false;
  }
  async recover(start = true) {
    await this.store.update((state) => {
      state.chats ||= {};
      state.seen ||= [];
      for (const chat of Object.values(state.chats)) {
        chat.queue ||= [];
        for (const item of chat.queue) {
          if (item.status === 'running') {
            // Never replay a task that may already have changed files.
            item.status = 'reply_pending';
            item.result = '上次任务随 Agent 退出而中断，未自动重做。请检查已有结果后重新发送请求。';
          }
        }
      }
    });
    const state = await this.store.read();
    if (start) for (const id of Object.keys(state.chats)) this.pump(id);
  }
  ingest(event) {
    const previous = this.incoming.get(event.chatId) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.receive(event));
    this.incoming.set(event.chatId, current);
    current.finally(() => { if (this.incoming.get(event.chatId) === current) this.incoming.delete(event.chatId); }).catch(() => {});
    return current;
  }
  async receive({ id, chatId, text = '', images = [], chatType = 'p2p' }) {
    if (this.stopped || chatType !== 'p2p' || (!text.trim() && !images.length)) return false;
    const pending = this.questions.get(chatId);
    const before = await this.store.read();
    const newQueued = before.chats?.[chatId]?.queue.some((job) => job.kind === 'new');
    const explicitReply = /^\/reply\s+([\s\S]+)$/.exec(text.trim());
    const isAnswer = pending && !images.length && text.trim() !== '/new' && (!newQueued || explicitReply);
    const isNew = !images.length && text.trim() === '/new';
    let busy = false;
    const accepted = await this.store.update((state) => {
      state.seen ||= [];
      if (state.seen.includes(id)) return false;
      state.seen.push(id);
      state.seen = state.seen.slice(-4096);
      if (!isAnswer) {
        state.chats ||= {};
        const chat = state.chats[chatId] ||= { queue: [], session: null, revision: this.revision };
        busy = chat.queue.some((job) => ['running', 'reply_pending'].includes(job.status));
        chat.queue.push({ id, text, ...(images.length ? { images } : {}), kind: isNew ? 'new' : 'message', status: 'queued' });
      }
      return true;
    });
    if (!accepted) return false;
    if (isAnswer) {
      this.questions.delete(chatId);
      pending.resolve(explicitReply ? explicitReply[1] : text);
      return true;
    }
    if (busy && isNew) {
      await this.send(chatId, '将在当前任务完成后新建会话。' +
        (pending ? '\n当前任务还在等待回答，请用 /reply 你的答案 回答；其他消息会留给新会话。' : ''), 'waiting:' + id);
    }
    this.pump(chatId);
    return true;
  }
  pump(chatId) {
    if (this.workers.has(chatId) || this.stopped) return;
    const worker = this.drain(chatId).catch(() => {}).finally(() => {
      this.workers.delete(chatId);
      this.activity(this.busy);
    });
    this.workers.set(chatId, worker);
    this.activity(this.busy);
  }
  get busy() { return this.workers.size; }
  async drain(chatId) {
    while (!this.stopped && await this.canStart()) {
      const state = await this.store.read();
      const chat = state.chats[chatId];
      const job = chat?.queue[0];
      if (!job) return;
      if (chat.revision !== this.revision) {
        await this.store.update((value) => {
          value.chats[chatId].session = null;
          value.chats[chatId].revision = this.revision;
        });
        chat.session = null;
      }
      if (job.status !== 'reply_pending') {
        await this.store.update((value) => { value.chats[chatId].queue[0].status = 'running'; });
        try {
          if (job.kind === 'new') {
            // Allocation establishes an empty session; history is created lazily on its first turn.
            const session = { id: randomUUID(), fresh: true };
            await this.driver.releaseSession?.(chat.session?.id);
            await this.store.update((value) => { value.chats[chatId].session = session; });
            job.result = '已新建会话。';
            job.ok = false;
          } else {
            const session = chat.session || { id: randomUUID(), fresh: true };
            const input = await this.prepareInput(job);
            const result = await this.driver.run({
              ...input, session: clone(session),
              onSession: async (id) => {
                await this.store.update((value) => { value.chats[chatId].session = { id, fresh: false }; });
              },
              ask: (question, signal) => this.ask(chatId, question, signal),
            });
            job.result = await this.prepareResult(result, job.id) || '任务已完成。';
            job.ok = true;
          }
        } catch (error) {
          job.result = error instanceof MediaError ? error.userMessage : '任务未完成。请检查 Agent 的登录、模型配置或权限后重新发送请求；本次未自动重试。';
          job.ok = false;
          if (!(error instanceof MediaError)) this.failure();
        }
        await this.store.update((value) => {
          const current = value.chats[chatId].queue[0];
          current.status = 'reply_pending';
          current.result = job.result;
          current.ok = job.ok;
        });
      }
      // The result is durable before sending. A restart retries delivery, not the Agent task.
      await this.send(chatId, job.result, (job.ok ? 'result:' : 'control:') + job.id);
      await this.store.update((value) => {
        if (value.chats[chatId].queue[0]?.id === job.id) value.chats[chatId].queue.shift();
      });
      await this.cleanup(job.id).catch(() => {});
    }
  }
  async ask(chatId, question, signal) {
    if (this.questions.has(chatId)) throw new Error('这个会话已有等待回答的问题。');
    const id = randomUUID();
    let rejectPending;
    const answer = new Promise((resolve, reject) => {
      rejectPending = reject;
      this.questions.set(chatId, { id, resolve, reject });
    });
    answer.catch(() => {});
    const aborted = () => {
      if (this.questions.get(chatId)?.id === id) this.questions.delete(chatId);
      rejectPending(new Error('问题已取消。'));
    };
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    try {
      const queued = (await this.store.read()).chats?.[chatId]?.queue.some((job) => job.kind === 'new');
      await this.send(chatId, question + (queued ? '\n/new 正在排队。请回复 /reply 你的答案，以便先完成当前任务。' : ''), 'question:' + id);
      return await answer;
    } finally {
      signal?.removeEventListener('abort', aborted);
      if (this.questions.get(chatId)?.id === id) this.questions.delete(chatId);
    }
  }
  async idle() { await Promise.all([...this.workers.values()]); }
  async stop() {
    this.stopped = true;
    for (const entry of this.questions.values()) entry.reject(new Error('Agent 已退出。'));
    this.questions.clear();
    await this.driver.close?.();
    await this.idle();
  }
}

export const conversationFile = (root, channelId) => root + '/sessions/' + hash(channelId) + '.json';
