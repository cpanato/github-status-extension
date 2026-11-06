import { settingsFrom, type Cache } from "./domain.js";
export const emptyCache = (): Cache => ({ failures: 0, nextAttemptAt: 0 });
export async function readCache(): Promise<Cache> {
  const data = await chrome.storage.local.get("cache");
  return (data.cache as Cache | undefined) ?? emptyCache();
}
export async function readSettings() {
  return settingsFrom((await chrome.storage.local.get("settings")).settings);
}
