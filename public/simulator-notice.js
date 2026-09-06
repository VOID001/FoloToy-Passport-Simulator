export const SIMULATOR_NOTICE_STORAGE_KEY =
  "folotoy.simulator-notice.shown";

export function showSimulatorNoticeOnce(
  dialog,
  storage = globalThis.localStorage,
) {
  try {
    if (storage.getItem(SIMULATOR_NOTICE_STORAGE_KEY) === "1") return false;
  } catch {
    // Keep the notice usable when storage is blocked by the browser.
  }

  dialog.showModal();

  try {
    storage.setItem(SIMULATOR_NOTICE_STORAGE_KEY, "1");
  } catch {
    // Storage failure should not prevent the simulator from starting.
  }

  return true;
}
