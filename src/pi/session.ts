import { readFile, writeFile } from 'node:fs/promises';
import { AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionFactory, type LoadSkillsResult, ModelRuntime,
  SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

/** A model inside Pi. Choosing one selects where Pi sends requests; it is not a backend switch. */
export interface PiTarget { provider: string; model: string }

type CreateOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
export type PiThinkingLevel = NonNullable<CreateOptions['thinkingLevel']>;

/**
 * Skills from these directories alone, in this order: Pi keeps the first skill of a name. Pi's discovery stays off, so
 * nothing in the agent or the working directory is loaded (ADR 0004, ADR 0073). `settle` turns the skills as Pi loaded
 * them into the ones the session lists; it is called once, when the session is made, and the list stays as it is.
 */
export interface PiSkills { directories: string[]; settle: (loaded: LoadSkillsResult) => LoadSkillsResult }

/** A saved session could not be restored. It is never replaced by a new session. */
export class PiSessionRestoreError extends Error {
  constructor(message: string) { super(message); this.name = 'PiSessionRestoreError'; }
}

export interface PiSessionOptions {
  cwd: string;
  agentDir: string;
  sessionDir: string;
  modelRuntime: ModelRuntime;
  target: PiTarget;
  systemPrompt: string;
  thinkingLevel: PiThinkingLevel;
  /** A saved session file to restore. */
  file?: string;
  /** The session ID the caller recorded for `file`. */
  expectedSessionId?: string;
  /**
   * The tool allowlist and its definitions. Without it Pi has no tools at all (ADR 0004). `declared`, when given, is the
   * part of the allowlist the model is shown; the rest is callable from Codemode scripts only (ADR 0066).
   */
  tools?: { names: string[]; definitions: CreateOptions['customTools']; declared?: string[] };
  /** How much recent context a compaction keeps unsummarized. Pi's default when omitted. */
  keepRecentTokens?: number;
  /**
   * Extensions given here, in code. They are the only ones: Pi's discovery of extensions on disk stays off, so nothing
   * in the agent or data directory is ever loaded as one (ADR 0004, ADR 0047).
   */
  extensions?: ExtensionFactory[];
  /** Without it, no skill is loaded at all (ADR 0004). */
  skills?: PiSkills;
}

/**
 * The header session ID of a saved session. Every non-empty line must be JSON: Pi skips malformed lines when it
 * loads, which must not count as a successful restore (ADR 0001).
 */
export async function readSessionId(file: string): Promise<string> {
  try {
    const entries = (await readFile(file, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    const header = entries[0];
    if (header.type !== 'session' || typeof header.id !== 'string') throw new Error();
    return header.id;
  } catch { throw new PiSessionRestoreError('Missing or invalid Pi session'); }
}

/** One Pi integration boundary. No backend registry or alternate adapter. */
export async function openPiSession(options: PiSessionOptions): Promise<AgentSession> {
  const { cwd, agentDir, sessionDir, modelRuntime, target, file } = options;
  let expectedId: string | undefined;
  if (file) {
    // SessionManager.open can create a new session for a nonexistent/invalid file.
    // Fail closed before calling it so a lost conversation is never silently replaced.
    expectedId = await readSessionId(file);
    if (options.expectedSessionId !== undefined && options.expectedSessionId !== expectedId) {
      throw new PiSessionRestoreError('Pi session identity mismatch');
    }
  }
  const model = modelRuntime.getModel(target.provider, target.model);
  if (!model) throw new Error('Pinned Pi model unavailable');
  // Pi never compacts on its own; the thinking loop compacts between turns (ADR 0009).
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, ...(options.keepRecentTokens ? { keepRecentTokens: options.keepRecentTokens } : {}) },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, extensionFactories: options.extensions ?? [], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    ...(options.skills ? { additionalSkillPaths: options.skills.directories, skillsOverride: options.skills.settle } : {}),
    systemPrompt: options.systemPrompt,
  });
  await resourceLoader.reload();
  const { session, modelFallbackMessage } = await createAgentSession({ cwd, agentDir, modelRuntime, model,
    sessionManager: file ? SessionManager.open(file, sessionDir, cwd) : SessionManager.create(cwd, sessionDir),
    settingsManager, resourceLoader, tools: options.tools?.names ?? [], customTools: options.tools?.definitions ?? [],
    thinkingLevel: options.thinkingLevel,
  });
  if (expectedId && session.sessionId !== expectedId) {
    session.dispose(); throw new PiSessionRestoreError('Pi session identity mismatch');
  }
  if (modelFallbackMessage || session.model?.provider !== target.provider || session.model.id !== target.model) {
    session.dispose(); throw new Error('Pi model fallback refused');
  }
  // Pi declares every tool the allowlist names, whatever its exposure; this takes back the ones scripts alone reach.
  if (options.tools?.declared) session.setActiveToolsByName(options.tools.declared);
  return session;
}

/**
 * A new session whose file exists from the start. Pi itself writes a session file only after the first assistant
 * reply, so a stop before that would leave a recorded reference to a missing file. The header is written here and the
 * session is then opened through the same checks as any restore.
 */
export async function createPersistedPiSession(options: Omit<PiSessionOptions, 'file' | 'expectedSessionId'>): Promise<AgentSession> {
  if (!options.modelRuntime.getModel(options.target.provider, options.target.model)) throw new Error('Pinned Pi model unavailable');
  const manager = SessionManager.create(options.cwd, options.sessionDir);
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) throw new Error('Pi session was not persisted');
  await writeFile(file, `${JSON.stringify(header)}\n`, { flag: 'wx', mode: 0o600 });
  return openPiSession({ ...options, file, expectedSessionId: header.id });
}
