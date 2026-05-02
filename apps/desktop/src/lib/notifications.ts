import {
  isPermissionGranted,
  requestPermission,
  sendNotification
} from "@tauri-apps/plugin-notification";

export async function ensureNotificationPermission() {
  let granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === "granted";
  }
  return granted;
}

export async function notify(title: string, body: string) {
  const granted = await ensureNotificationPermission();
  if (!granted) return;
  sendNotification({ title, body });
}
