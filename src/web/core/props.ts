import type { AvatarManifest } from '../../shared/protocol/avatar.ts';
import { PLACEMENTS, type Approval, type Expression, type Placement, type ShownImage, type ShownMessage } from '../../shared/protocol/conversation.ts';
import { SETTING_KEYS, type SettingKey, type SettingsView } from '../../shared/protocol/settings.ts';
import { readIndex } from './mediator.ts';
import { isLimitKey } from './settings.ts';
import type { AppState, ApprovalFlow } from './state.ts';
import { codeWords } from './words.ts';

/**
 * The props of the two screens (ADR 0058; the Mac's `UIProps`, mac/CLAUDE.md): everything the view draws, worked out
 * from the state by pure functions. The view gets these and nothing of the state; every word that changes with the
 * state is here, and so is what each button hands back.
 */

/** The name shown before the avatar's list has come: the built-in avatar's (ADR 0057). */
const DEFAULT_NAME = 'なつみ';

export interface StatusProps { tone: 'ok' | 'busy' | 'warn'; text: string }

export interface ImageProps { src: string; alt: string; width?: number; height?: number }

export interface RowProps {
  id: string;
  side: 'owner' | 'natsumi';
  speaker: string;
  /** The face of the line's feeling, for her lines only. */
  face?: string;
  /** お知らせ, for a notice. */
  label?: string;
  text: string;
  time: string;
  images: ImageProps[];
  unread: boolean;
  /** The check a notice not checked yet offers. */
  ack?: { label: string; notificationId: string };
}

export interface OutboxProps { requestId: string; text: string; note: string; failed: boolean }

export interface ConfirmProps {
  question: string;
  /** The text that will be posted, or undefined when nothing will be. */
  text?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
}

export interface ApprovalProps {
  id: string;
  channel: string;
  replyTo?: { speaker: string; at: string; text: string };
  text: string;
  images: ImageProps[];
  flagged: string[];
  verdict: string;
  history: string[];
  expires: string;
  /** The choice of where a reply goes, when there is one to make. */
  placement?: { selected: Placement; options: { value: Placement; label: string }[] };
  mode: 'idle' | 'editing' | 'confirming' | 'sending';
  confirm?: ConfirmProps;
  error?: string;
}

export interface ChatProps {
  screen: 'chat';
  name: string;
  face?: string;
  status: StatusProps;
  /** The button that opens the socket again, when it will not be opened by itself. */
  reconnect?: { label: string };
  thinking?: string;
  unreadCount: number;
  rows: RowProps[];
  outbox: OutboxProps[];
  composer: { placeholder: string; sentCount: number };
  approvals: ApprovalProps[];
  results: string[];
}

export type ControlProps =
  | { kind: 'select'; options: { value: string; label: string; disabled: boolean }[]; selected: string }
  | { kind: 'number'; value: string; min: number; unit: string }
  | { kind: 'hours'; start: string; end: string }
  | { kind: 'ping'; value: string; off: boolean; min: number }
  | { kind: 'thresholds'; owner: string; return: string };

export interface SettingRowProps {
  key: SettingKey;
  label: string;
  help: string;
  valueText: string;
  configText: string;
  overridden: boolean;
  /** 次のターンから, while what is in use is not the value yet. */
  note?: string;
  control: ControlProps;
  canReset: boolean;
  busy: boolean;
  error?: string;
}

export interface SettingsProps {
  screen: 'settings';
  name: string;
  face?: string;
  status: StatusProps;
  reconnect?: { label: string };
  rows: SettingRowProps[];
}

export type ScreenProps = ChatProps | SettingsProps;

export const screenProps = (state: AppState): ScreenProps => (state.screen === 'chat' ? chatProps(state) : settingsProps(state));

// The page's head.

function faceOf(avatar: AvatarManifest | undefined, expression: Expression | undefined): string | undefined {
  if (!avatar) return undefined;
  for (const feeling of [expression ?? 'neutral', 'neutral']) {
    const path = avatar.files.find(file => file === `icons/${feeling}.webp` || file === `icons/${feeling}.png`);
    if (path) return `/v1/avatar/${avatar.version}/${path}`;
  }
  return undefined;
}

function statusOf(state: AppState): { status: StatusProps; reconnect?: { label: string } } {
  switch (state.link) {
    case 'idle': case 'connecting': case 'syncing':
      if (state.unavailable) return { status: { tone: 'warn', text: codeWords(state.unavailable) } };
      return { status: { tone: 'busy', text: 'つないでいます…' } };
    case 'waiting': return { status: { tone: 'warn', text: 'つながりが切れました。つなぎ直しています…' } };
    case 'replaced': return { status: { tone: 'warn', text: '別のタブでつながったため、ここは止めました。' }, reconnect: { label: 'ここでつなぎ直す' } };
    case 'signed-out': return { status: { tone: 'warn', text: 'ログインが切れました。ログインし直します…' } };
    case 'synced':
      if (state.unavailable) return { status: { tone: 'warn', text: codeWords(state.unavailable) } };
      if (Object.keys(state.pending).length > 0) return { status: { tone: 'busy', text: '考え中…' } };
      return { status: { tone: 'ok', text: 'つながっています' } };
  }
}

// The chat.

const timeFormat = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const timeOf = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : timeFormat.format(date);
};

const imagesOf = (images: ShownImage[] | undefined): ImageProps[] => (images ?? []).map((image, index, all) => ({
  src: `/v1/images/${encodeURIComponent(image.imageId)}`, alt: `画像 ${index + 1} / ${all.length}`,
  ...(image.width && image.height ? { width: image.width, height: image.height } : {}),
}));

export function chatProps(state: AppState): ChatProps {
  const name = state.avatar?.name ?? DEFAULT_NAME;
  const read = readIndex(state);
  const checking = new Set(state.localReads.filter(change => change.kind === 'ack').map(change => change.id));
  const notices = new Set(state.unacknowledged.filter(id => !checking.has(id)));
  const listedUnread = state.messages.slice(read + 1).filter(message => message.kind === 'reply').length;
  const face = faceOf(state.avatar, state.expression);
  return {
    screen: 'chat', name, ...(face ? { face } : {}), ...statusOf(state),
    ...(state.thinkingLine ? { thinking: state.thinkingLine } : {}),
    unreadCount: read < 0 ? Math.max(state.unreadReplyCount, listedUnread) : listedUnread,
    rows: state.messages.map((message, index) => rowOf(message, index > read, notices, name, state.avatar)),
    outbox: state.outbox.map(item => ({
      requestId: item.requestId, text: item.text, failed: item.status === 'failed',
      note: item.status === 'failed' ? codeWords(item.code ?? '') : '送っています…',
    })),
    composer: { placeholder: `${name}に話しかける`, sentCount: state.sentCount },
    approvals: state.approvals.map(approval => approvalProps(approval, state.flows[approval.approvalId] ?? { step: 'idle' })),
    results: state.results,
  };
}

function rowOf(message: ShownMessage, afterRead: boolean, notices: Set<string>, name: string, avatar: AvatarManifest | undefined): RowProps {
  const hers = message.role === 'natsumi';
  const face = hers ? faceOf(avatar, message.expression) : undefined;
  const ack = message.kind === 'notice' && notices.has(message.messageId);
  return {
    id: message.messageId, side: hers ? 'natsumi' : 'owner', speaker: hers ? name : 'あなた',
    ...(face ? { face } : {}), ...(message.kind === 'notice' ? { label: 'お知らせ' } : {}),
    text: message.text, time: timeOf(message.createdAt), images: imagesOf(message.images),
    unread: (message.kind === 'reply' && afterRead) || ack,
    ...(ack ? { ack: { label: '確認した', notificationId: message.messageId } } : {}),
  };
}

// The approvals.

const PLACEMENT_LABELS = { thread: 'スレッドに返す', channel: 'チャンネルに出す', broadcast: 'スレッドに返し、チャンネルにも出す' } as const;
const VERDICTS = { owner: '判定が本人に回しました', 'no-verdict': '判定できませんでした', 'rewrite-limit': '3 回目も突き返されました' } as const;

function approvalProps(approval: Approval, flow: ApprovalFlow): ApprovalProps {
  const { target } = approval;
  const placement = target.replyTo
    ? { selected: flow.step === 'confirming' && flow.placement ? flow.placement : target.placement,
      options: PLACEMENTS.map(value => ({ value, label: PLACEMENT_LABELS[value] })) }
    : undefined;
  return {
    id: approval.approvalId, channel: target.channel, ...(target.replyTo ? { replyTo: target.replyTo } : {}),
    text: approval.text, images: imagesOf(approval.images),
    flagged: approval.reason.issues.filter(issue => issue.flagged).map(issue => issue.label),
    verdict: VERDICTS[approval.reason.verdict], history: approval.history.map(item => item.text),
    expires: `${timeOf(approval.expiresAt)} まで`, ...(placement ? { placement } : {}),
    mode: flow.step === 'idle' ? 'idle' : flow.step,
    ...(flow.step === 'confirming' ? { confirm: confirmOf(approval, flow) } : {}),
    ...((flow.step === 'idle' || flow.step === 'editing') && flow.error ? { error: flow.error } : {}),
  };
}

function confirmOf(approval: Approval, flow: Extract<ApprovalFlow, { step: 'confirming' }>): ConfirmProps {
  const { channel, replyTo } = approval.target;
  const placement = flow.placement ?? approval.target.placement;
  // Images cannot be shown in the channel from a thread: a broadcast of them stays in the thread (ADR 0062).
  const where = !replyTo ? `${channel} に投稿します`
    : placement === 'channel' ? `${channel} のチャンネルに出します`
      : placement === 'broadcast' && !approval.images?.length ? `${channel} のスレッドに返し、チャンネルにも出します`
        : `${channel} のスレッドに返します`;
  const images = approval.images?.length ? `画像 ${approval.images.length} 枚も一緒に送ります。` : '';
  switch (flow.decision) {
    case 'approve':
      return { question: `この下書きを ${where}。${images}よろしいですか？`, text: approval.text, confirmLabel: '送る', cancelLabel: 'やめる', danger: false };
    case 'edit':
      return { question: `直した本文を ${where}。${images}よろしいですか？`, text: flow.text!, confirmLabel: '直して送る', cancelLabel: '戻る', danger: false };
    case 'reject':
      return { question: `${channel} への投稿を却下します。何も送られません。よろしいですか？`, confirmLabel: '却下する', cancelLabel: 'やめる', danger: true };
  }
}

// The settings.

const LABELS: Record<SettingKey, { label: string; help: string; unit?: string }> = {
  modelRoute: { label: 'モデルの経路', help: '考えるのに使うモデル。次のターンの前に移ります。' },
  turnFold: { label: '畳み込み', help: '終わったターンを畳んで、記録を短く保ちます。次のターンから効きます。' },
  eventModelCalls: { label: '出来事ごとの呼び出しの上限', help: '1 つの出来事のターンでモデルを呼べる回数。次のターンから。', unit: '回' },
  eventTimeoutMinutes: { label: '出来事ごとの時間の上限', help: '1 つの出来事のターンにかけられる時間。次のターンから。', unit: '分' },
  reviewModelCalls: { label: '夜の振り返りの呼び出しの上限', help: '振り返りのターンでモデルを呼べる回数。次の振り返りから。', unit: '回' },
  reviewTimeoutMinutes: { label: '夜の振り返りの時間の上限', help: '振り返りのターンにかけられる時間。次の振り返りから。', unit: '分' },
  awakeHours: { label: '起きている時間帯', help: 'この間だけ合図や見回りをします。日をまたいでも構いません。' },
  pingIntervalMinutes: { label: '合図の間隔', help: '静かな時間がこれだけ続くと、なつみに合図します。5 分以上。' },
  judgeLogprobs: { label: 'ポッポさんの判定: logprobs', help: 'なつみのモデルの logprobs で下書きを判定します。次の下書きから。' },
  judgeJev: { label: 'ポッポさんの判定: Jev', help: 'TypeSafe の Jev で下書きを判定します。従量課金です。次の下書きから。' },
  judgeLogprobsThresholds: { label: 'logprobs のしきい値', help: 'この点数以上で本人へ回し、もう一方以上で突き返します。0 より大きく 1 以下。次の下書きから。' },
  judgeJevThresholds: { label: 'Jev のしきい値', help: 'この点数以上で本人へ回し、もう一方以上で突き返します。0 より大きく 1 以下。次の下書きから。' },
  judgeAdopted: { label: 'ポッポさんの採用する判定', help: 'この判定で決めます。答えが無ければもう一方で、両方だめなら本人に回します。次の下書きから。' },
  curatorRoute: { label: '記憶の整理係の経路', help: '夜に記憶を組み直す係が使うモデル。係は毎晩、記憶とその日の会話の本文をこの経路の接続先へ送ります。'
    + 'ChatGPT Plus など外のサービスの経路を選ぶと、それらが毎晩外に出ます。次の夜から。' },
  curatorModelCalls: { label: '整理係の呼び出しの上限', help: '係の夜の工程ごとにモデルを呼べる回数。工程ごとにまるごと使えます。次の夜から。', unit: '回' },
  curatorTimeoutMinutes: { label: '整理係の時間の上限', help: '係の夜の工程ごとにかけられる時間。工程ごとにまるごと使えます。次の夜から。', unit: '分' },
};

/** What the curator's route is shown as when it has none of its own (ADR 0068). */
const NATSUMI_ROUTE = 'なつみと同じ経路';

function valueText(key: SettingKey, value: unknown, view: SettingsView): string {
  if (key === 'awakeHours') {
    const hours = value as { start: string; end: string };
    return `${hours.start}〜${hours.end}（${view.awakeHours.timeZone}）`;
  }
  if (key === 'pingIntervalMinutes') return value === false ? '合図しない' : `${String(value)} 分`;
  if (key === 'judgeLogprobsThresholds' || key === 'judgeJevThresholds') {
    const thresholds = value as { owner: number; return: number };
    return `本人へ ${thresholds.owner}・突き返す ${thresholds.return}`;
  }
  if (key === 'curatorRoute') return value === null ? NATSUMI_ROUTE : String(value);
  if (isLimitKey(key)) return `${String(value)} ${LABELS[key].unit}`;
  return String(value);
}

function controlOf(key: SettingKey, view: SettingsView): ControlProps {
  switch (key) {
    case 'modelRoute':
      return { kind: 'select', selected: view.modelRoute.value, options: view.modelRoute.routes.map(route => ({
        value: route.name, label: `${route.name}（${route.model}）${route.ready ? '' : ' — 使えません'}`, disabled: !route.ready })) };
    case 'curatorRoute': {
      const { value, outside } = view.curatorRoute;
      return { kind: 'select', selected: value ?? '', options: [{ value: '', label: NATSUMI_ROUTE, disabled: false },
        ...view.modelRoute.routes.map(route => ({ value: route.name, disabled: !route.ready,
          label: `${route.name}（${route.model}）${outside.includes(route.name) ? ' — 外のサービス' : ''}${route.ready ? '' : ' — 使えません'}` }))] };
    }
    case 'turnFold':
      return { kind: 'select', selected: view.turnFold.value, options: [{ value: 'on', label: 'on', disabled: false }, { value: 'off', label: 'off', disabled: false }] };
    case 'judgeLogprobs': case 'judgeJev': {
      const { value, available } = view[key];
      return { kind: 'select', selected: value, options: [{ value: 'on', label: 'on', disabled: !available }, { value: 'off', label: 'off', disabled: false }] };
    }
    case 'judgeLogprobsThresholds': case 'judgeJevThresholds':
      return { kind: 'thresholds', owner: String(view[key].value.owner), return: String(view[key].value.return) };
    case 'judgeAdopted':
      return { kind: 'select', selected: view.judgeAdopted.value, options: (['logprobs', 'jev'] as const).map(value => ({ value, label: value, disabled: false })) };
    case 'awakeHours':
      return { kind: 'hours', start: view.awakeHours.value.start, end: view.awakeHours.value.end };
    case 'pingIntervalMinutes': {
      const { value, config } = view.pingIntervalMinutes;
      return { kind: 'ping', off: value === false, value: String(value === false ? (config === false ? 180 : config) : value), min: 5 };
    }
    default:
      return { kind: 'number', value: String(view[key].value), min: 1, unit: LABELS[key].unit ?? '' };
  }
}

function noteOf(key: SettingKey, view: SettingsView): string | undefined {
  if (key === 'modelRoute' && view.modelRoute.inUse !== view.modelRoute.value) {
    return `次のターンから（いまは ${view.modelRoute.inUse ?? '話せない状態'}）`;
  }
  if (key === 'turnFold' && view.turnFold.inUse !== view.turnFold.value) return `次のターンから（いまは ${view.turnFold.inUse}）`;
  if ((key === 'judgeLogprobs' || key === 'judgeJev') && !view[key].available) return 'config に接続先がありません。on にはできません。';
  if (key === 'curatorRoute') {
    const { night, outside } = view.curatorRoute;
    return `次の夜は ${night} で動きます。${outside.includes(night) ? '外のサービスの経路なので、記憶とその日の会話の本文がそこへ送られます。' : ''}`;
  }
  return undefined;
}

export function settingsProps(state: AppState): SettingsProps {
  const name = state.avatar?.name ?? DEFAULT_NAME;
  const face = faceOf(state.avatar, state.expression);
  const view = state.settings;
  const rows = view ? SETTING_KEYS.map((key): SettingRowProps => {
    const item = view[key];
    const entry = state.settingEntries[key] ?? {};
    const note = noteOf(key, view);
    return {
      key, label: LABELS[key].label, help: LABELS[key].help,
      valueText: valueText(key, item.value, view), configText: valueText(key, item.config, view),
      overridden: item.overridden, ...(note ? { note } : {}), control: controlOf(key, view),
      canReset: item.overridden, busy: entry.pending !== undefined, ...(entry.error ? { error: entry.error } : {}),
    };
  }) : [];
  return { screen: 'settings', name, ...(face ? { face } : {}), ...statusOf(state), rows };
}
