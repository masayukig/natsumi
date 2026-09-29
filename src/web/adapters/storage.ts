/**
 * The device the server gave this browser (docs/client-contract.md, 端末の登録と stream), kept in localStorage so that
 * the next page is the same device. A browser that keeps nothing (a private window) is a new device each time.
 */
const DEVICE_KEY = 'natsumi.deviceId';

export function readDevice(): string | undefined {
  try { return localStorage.getItem(DEVICE_KEY) ?? undefined; } catch { return undefined; }
}

export function rememberDevice(deviceId: string): void {
  try { localStorage.setItem(DEVICE_KEY, deviceId); } catch { /* kept for this page only */ }
}
