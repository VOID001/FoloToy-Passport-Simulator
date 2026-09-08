export const MAX_FIRMWARE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_FIRMWARE_PRESET_ID = "official-demo";
export const COMMUNITY_ORIGIN = "https://ai-passport.folotoy.cn";
export const FIRMWARE_PRESET_IDS_BY_URL_ID = Object.freeze({
  1: "music-keychain",
  2: "answer-book",
  3: DEFAULT_FIRMWARE_PRESET_ID,
  4: "feishu-calendar-assistant",
});

export function resolveCommunityPlayUrl(search) {
  const parameters = new URLSearchParams(search);
  if (!parameters.has("play")) return null;

  const playId = parameters.get("play");
  if (!/^[1-9]\d*$/.test(playId || "")) {
    throw new Error("URL 参数 play 必须是正整数玩法 ID");
  }
  return `${COMMUNITY_ORIGIN}/plays/${playId}/`;
}

export function resolveFirmwarePresetId(
  search,
  availableIds,
  defaultId = DEFAULT_FIRMWARE_PRESET_ID,
) {
  const ids = availableIds instanceof Set ? availableIds : new Set(availableIds);
  if (!ids.has(defaultId)) {
    throw new Error(`默认固件不存在: ${defaultId}`);
  }

  const urlId = new URLSearchParams(search).get("id");
  const requestedId = Object.hasOwn(FIRMWARE_PRESET_IDS_BY_URL_ID, urlId)
    ? FIRMWARE_PRESET_IDS_BY_URL_ID[urlId]
    : undefined;
  return ids.has(requestedId) ? requestedId : defaultId;
}

export function formatFirmwareSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function validateFirmwareFile(file) {
  if (!file.name.toLowerCase().endsWith(".bin")) {
    throw new Error("请选择 .bin 固件镜像");
  }
  if (file.size === 0) throw new Error("固件文件为空");
  if (file.size > MAX_FIRMWARE_BYTES) {
    throw new Error("固件超过 ESP32-C3 的 8 MB Flash 容量");
  }
}
