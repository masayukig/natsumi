import type { ApprovalResolution } from '../../shared/protocol/conversation.ts';

/** The server's codes, and what became of approvals, in words the owner reads. */

const CODES: Record<string, string> = {
  'invalid-request': '形が正しくないため受け付けられませんでした。',
  'request-conflict': '同じ送信が別の内容で届いたため受け付けられませんでした。',
  'sync-required': 'つながり直している途中でした。もう一度試してください。',
  'device-mismatch': '別の端末として扱われました。ページを開き直してください。',
  'stale-revision': '承認の中身が変わりました。見直してから決めてください。',
  'unknown-setting': 'この設定はサーバーが知りません。',
  'invalid-value': '値が決まりに合わないため受け付けられませんでした。',
  'unknown-route': 'その経路はサーバーの設定にありません。',
  'route-unavailable': 'その経路はいま使える状態にありません。',
  'judge-unavailable': 'その判定は config に接続先が無いため、on にできません。',
  'pi-unavailable': 'なつみがいま話せない状態です。',
  'conversation-restore-failed': '会話を読み込めず、なつみがいま話せない状態です。',
  stopping: 'サーバーが止まるところで、なつみがいま話せない状態です。',
  'not-implemented': 'サーバーがまだこの操作に対応していません。',
};

/** Why turning the notifications on did not go through (ADR 0065). */
export const pushWords = (error: 'denied' | 'failed'): string => (error === 'denied'
  ? '通知が許可されていません。ブラウザの設定で、このサイトの通知を許可してください。'
  : '通知を有効にできませんでした。');

export const codeWords = (code: string): string => CODES[code] ?? `受け付けられませんでした（${code}）。`;

/** Whether the code says natsumi cannot talk now, which `service.unavailable` carries. */
export const unavailableWords = (code: string): string => CODES[code] ?? `なつみがいま話せない状態です（${code}）。`;

const FAILURES: Record<string, string> = {
  'mechanical-check': '送る前の検査に通りませんでした',
  'slack-error': 'Slack に断られました',
  'target-gone': '返信先が無くなっていました',
};

export function resolutionWords(channel: string | undefined, resolution: ApprovalResolution): string {
  const where = channel ?? '投稿';
  switch (resolution.state) {
    case 'rejected': return `${where} への投稿を却下しました。`;
    case 'expired': return `${where} への投稿は期限が切れました。`;
    default:
      if (resolution.delivery === 'failed') {
        return `${where} に送れませんでした（${FAILURES[resolution.reason ?? ''] ?? resolution.reason ?? '理由は不明'}）。`;
      }
      return resolution.delivery === 'sent' ? `${where} に送りました。` : `${where} への投稿を${resolution.state === 'edited' ? '直して' : ''}承認しました。`;
  }
}
