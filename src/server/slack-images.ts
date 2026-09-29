import { setTimeout as sleep } from 'node:timers/promises';
import { describeFailure, type SlackApi } from './slack-api.ts';

/**
 * Fork (ADR F01, ADR F03): posts the text, and the images if any, under the icon at `iconUrl`. An upload takes no icon,
 * so the images are uploaded unshared and shown by image blocks of one chat.postMessage. Blocks Slack refused as
 * invalid, perhaps while the files were still processing, are tried again after each of `retryDelays`; failing that,
 * or refused for another reason, the images go up as before with uploadFiles under the bot's icon, and `log` is told.
 */
export async function postWithImages(api: SlackApi, channel: string, text: string, files: { filename: string; data: Buffer }[],
  options: { iconUrl: string; threadTs?: string; username?: string; retryDelays?: number[]; log?: (line: string) => void }): Promise<void> {
  const { iconUrl, threadTs, username } = options;
  const posting = { iconUrl, ...(threadTs ? { threadTs } : {}), ...(username ? { username } : {}) };
  if (files.length === 0) return void await api.postMessage(channel, text, posting);
  const ids = await api.uploadUnshared(files);
  // A section holds mrkdwn as the plain `text` would show it, up to 3000 characters.
  const blocks = [
    ...(text.match(/[\s\S]{1,3000}/g) ?? []).map(part => ({ type: 'section', text: { type: 'mrkdwn', text: part } })),
    ...ids.map((id, index) => ({ type: 'image', slack_file: { id }, alt_text: files[index]!.filename })),
  ];
  const retryDelays = options.retryDelays ?? [1000, 2000];
  for (let attempt = 0; ; attempt += 1) {
    try { return void await api.postMessage(channel, text, { ...posting, blocks }); } catch (error) {
      const delay = retryDelays[attempt];
      if (delay !== undefined && (error as { reason?: unknown }).reason === 'invalid_blocks') { await sleep(delay); continue; }
      options.log?.(`images went up without her icon (${describeFailure(error)})`);
      break;
    }
  }
  await api.uploadFiles(channel, files, { ...(threadTs ? { threadTs } : {}), ...(text !== '' ? { initialComment: text } : {}) });
}
