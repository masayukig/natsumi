import { readAttachment } from '../../shared/protocol/conversation.ts';
import type { AppEvent, UploadError } from '../core/events.ts';

/**
 * One file of the chat to `POST /v1/uploads` (ADR 0071; docs/client-contract.md, ファイルの添付): its bytes as the body
 * and its name in the query. The browser sends the login's cookie and the Origin by itself. An image is pictured for
 * its chip first, from the file in hand.
 */
export async function uploadFile(file: File, localId: string, dispatch: (event: AppEvent) => void): Promise<void> {
  if (file.type.startsWith('image/')) dispatch({ type: 'attachment-preview', localId, url: URL.createObjectURL(file) });
  const failed = (code: UploadError) => dispatch({ type: 'upload-failed', localId, code });
  try {
    const response = await fetch(`/v1/uploads?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream', accept: 'application/json' },
    });
    if (response.status === 413) return failed('too-large');
    if (response.status === 401 || response.status === 403) return failed('unauthorized');
    const upload = response.status === 201 ? readAttachment(await response.json()) : undefined;
    if (!upload) return failed('failed');
    dispatch({ type: 'upload-done', localId, upload });
  } catch {
    failed('failed');
  }
}

/** Lets go of a chip's small picture. */
export function forgetPreview(url: string): void {
  URL.revokeObjectURL(url);
}
