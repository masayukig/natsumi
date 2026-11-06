import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { AgentSession, ModelRuntime, defineTool, type SessionEntry, type SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import { openPiSession, type PiTarget } from '../pi/session.ts';

// Pi subscription provider and its default model in Pi 0.87.1, not a separate agent backend. The server never
// reads it: its provider and model come from the config. Only the probe and the test fixtures pin a target here.
export const SUBSCRIPTION_TARGET: PiTarget = { provider: 'openai-codex', model: 'gpt-5.6-sol' };

// A fixture proposal only: it has no Google client, credentials, or write callback.
export const proposalTool = defineTool({
  name: 'calendar_propose', label: 'Propose a calendar change',
  description: 'Prepare a fictional proposal for human approval. Does not write to Calendar.',
  parameters: Type.Object({ title: Type.String() }),
  execute: async (_id, params) => ({ content: [{ type: 'text' as const, text: 'pending-approval' }],
    details: { title: params.title, status: 'pending-approval' } }),
});

/** The isolated probe harness: a private root, a synthetic instruction and only the proposal fixture tool. */
export async function createPiSession(root: string, modelRuntime: ModelRuntime, file?: string,
  target: PiTarget = SUBSCRIPTION_TARGET): Promise<AgentSession> {
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'pi');
  const sessionDir = join(root, 'sessions');
  for (const path of [cwd, agentDir, sessionDir]) await mkdir(path, { recursive: true, mode: 0o700 });
  return openPiSession({ cwd, agentDir, sessionDir, modelRuntime, target, file, thinkingLevel: 'off',
    systemPrompt: 'You are a synthetic protocol test. Use only the supplied messages. Do not access files or external tools.',
    tools: { names: ['calendar_propose'], definitions: [proposalTool] },
  });
}

export class PiConversation {
  private session: AgentSession;
  private busy = false;
  constructor(session: AgentSession) { this.session = session; }

  /** The conversation's messages. Pi also records the system prompt and the tools as system messages; they are left out. */
  history() {
    return this.session.sessionManager.getBranch().filter((entry: SessionEntry): entry is SessionMessageEntry =>
      entry.type === 'message' && entry.message.role !== 'system');
  }

  async send(text: string, timeout = 120_000): Promise<void> {
    if (this.busy) throw new Error('Pi conversation busy');
    this.busy = true;
    let expired = false;
    const timer = setTimeout(() => { expired = true; void this.session.abort(); }, timeout);
    const before = this.session.messages.length;
    try {
      await this.session.prompt(text, { expandPromptTemplates: false });
      if (expired) throw new Error('Pi response timeout');
      const reply = this.session.messages.slice(before).filter(m => m.role === 'assistant').at(-1);
      if (!reply || reply.role !== 'assistant' || reply.stopReason !== 'stop') throw new Error('Pi response failed');
    } catch {
      throw new Error(expired ? 'Pi response timeout' : 'Pi response failed');
    } finally { clearTimeout(timer); this.busy = false; }
  }
}
