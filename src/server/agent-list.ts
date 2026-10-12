import { join } from 'node:path';
import type { A2AClient, CardSummary } from './a2a-client.ts';
import type { A2AConfig } from './config.ts';
import { DOVE_NAME } from './dove.ts';
import { localDateTime } from './nightly.ts';
import { writeFileAtomically } from './paths.ts';

/**
 * Where the list of agents is written in the data directory. The workspace sees it, read-only, as `/manual/agents`
 * (ADR 0036): a volume subpath under Docker, a shared emptyDir on Kubernetes.
 */
export const AGENT_LIST_DIRECTORY = 'agents';
export const AGENT_LIST_FILE = 'INDEX.md';

/** Card text comes from outside, so each field is kept short. */
export const MAX_CARD_NAME_CHARS = 100;
export const MAX_CARD_DESCRIPTION_CHARS = 1000;
const MAX_SKILLS = 20;
const MAX_SKILL_DESCRIPTION_CHARS = 300;
const MAX_EXAMPLES = 3;
const MAX_EXAMPLE_CHARS = 200;

/**
 * Writes the list of agents natsumi can ask, from the config and each agent's Agent Card, fetched once, now
 * (ADR 0036). The names are the config's, the same ones `ask_agent` checks. An agent whose card cannot be had is
 * listed all the same, as out of reach for now. Neither a URL nor the token is written. The file is replaced whole,
 * so a start leaves nothing of the list before it.
 */
export async function writeAgentList(options: {
  directory: string; config: A2AConfig | undefined; client: A2AClient | undefined; now: number; timeZone: string;
  /** Slack is configured, so the dove is there to ask (ADR 0040). */
  dove?: boolean;
}): Promise<{ listed: string[]; unreachable: string[] }> {
  const agents = Object.entries(options.config?.agents ?? {});
  const client = options.client;
  const fetched = await Promise.all(agents.map(async ([name, { url }]) => {
    try { return { name, card: client ? await client.card(url) : undefined }; } catch { return { name, card: undefined }; }
  }));
  const lines = [
    '# 頼める相手',
    '',
    `サーバーが起動したとき（${localDateTime(options.now, options.timeZone)}）に書き出した、ask_agent で頼める相手の一覧です。`,
    'ask_agent の agent には、見出しの名前をそのまま書きます。説明は各相手が自分で名乗っているものです。',
  ];
  if (options.dove) lines.push('', `## ${DOVE_NAME}`, '', ...DOVE);
  if (fetched.length === 0 && !options.dove) lines.push('', '頼める相手はいません。');
  for (const { name, card } of fetched) lines.push('', `## ${name}`, '', ...(card ? describe(card) : UNREACHABLE));
  // Group-readable and no more: the workspace may run as another user of the shared group, and only reads it (ADR 0033).
  await writeFileAtomically(join(options.directory, AGENT_LIST_FILE), `${lines.join('\n')}\n`, 0o640);
  return { listed: [...options.dove ? [DOVE_NAME] : [], ...fetched.filter(entry => entry.card).map(entry => entry.name)],
    unreachable: fetched.filter(entry => !entry.card).map(entry => entry.name) };
}

/** The dove is the server's own, so what it does is written here rather than read from a card. */
const DOVE = [
  '- 名乗り: ポッポさん（Slack への送信役の鳩）',
  '- 説明: あなたの代わりに Slack へ投稿し（/work の画像も付けられます）、リアクションを付けます。投稿の下書きは判定にかけられ、そのまま届けるか、マスターに回すか、理由を添えて突き返します。',
  '- 頼み方: message は JSON のオブジェクトを 1 つ書きます。書き方と結果の読み方は /manual/slack.md にあります。',
];

const UNREACHABLE = ['- 今は取れない: 起動したときに、この相手の説明を取れませんでした。頼むことはできますが、何ができる相手かはここでは分かりません。'];

function describe(card: CardSummary): string[] {
  const lines = [`- 名乗り: ${field(card.name, MAX_CARD_NAME_CHARS) || '（名乗りなし）'}`];
  const description = field(card.description, MAX_CARD_DESCRIPTION_CHARS);
  if (description) lines.push(`- 説明: ${description}`);
  const skills = card.skills.slice(0, MAX_SKILLS);
  if (skills.length > 0) lines.push('- できること:');
  for (const skill of skills) {
    const examples = skill.examples.slice(0, MAX_EXAMPLES).map(example => `「${field(example, MAX_EXAMPLE_CHARS)}」`).join('');
    lines.push(`  - ${field(skill.name, MAX_CARD_NAME_CHARS)}: ${field(skill.description, MAX_SKILL_DESCRIPTION_CHARS)}`
      + (examples ? `（例: ${examples}）` : ''));
  }
  if (card.skills.length > MAX_SKILLS) lines.push(`  - ほか ${card.skills.length - MAX_SKILLS} 件`);
  return lines;
}

/** One line of outside text: control characters gone, line breaks folded into spaces, cut to `max` characters. */
function field(text: string, max: number): string {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const characters = [...line];
  return characters.length <= max ? line : `${characters.slice(0, max - 1).join('')}…`;
}
