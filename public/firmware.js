export const MAX_FIRMWARE_BYTES = 8 * 1024 * 1024;

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
