import { isObject, isString } from './conversation.ts';

/**
 * The avatar's list (`GET /v1/avatar`, docs/client-contract.md, アバター), as far as a device that shows only the faces
 * uses it: the version the files are served under, the display name, and the paths of the files there are.
 *
 * Part of the contract the server and the browser's app share. It imports nothing but the rest of the contract.
 */
export interface AvatarManifest { version: string; name: string; files: string[] }

export function readAvatarManifest(value: unknown): AvatarManifest | undefined {
  if (!isObject(value) || !isString(value.version) || !isString(value.name) || !Array.isArray(value.files)) return undefined;
  const files = value.files.map(file => (isObject(file) && isString(file.path) ? file.path : undefined));
  if (!files.every(isString)) return undefined;
  return { version: value.version, name: value.name, files };
}
