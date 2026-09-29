import { readAvatarManifest } from '../../shared/protocol/avatar.ts';
import type { AppEvent } from '../core/events.ts';

/** The avatar's list, from `/v1/avatar` (no login needed): its name and the paths of its faces (ADR 0057). */
export async function fetchAvatar(dispatch: (event: AppEvent) => void): Promise<void> {
  try {
    const response = await fetch('/v1/avatar', { headers: { accept: 'application/json' } });
    const manifest = response.ok ? readAvatarManifest(await response.json()) : undefined;
    dispatch(manifest ? { type: 'avatar-loaded', manifest } : { type: 'avatar-failed' });
  } catch {
    dispatch({ type: 'avatar-failed' });
  }
}
