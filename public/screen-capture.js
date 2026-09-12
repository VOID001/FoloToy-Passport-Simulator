export function canvasToPngBlob(canvas) {
  if (!canvas || typeof canvas.toBlob !== "function") {
    return Promise.reject(new TypeError("无法读取模拟器屏幕"));
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("无法生成屏幕截图"));
    }, "image/png");
  });
}

export async function copyCanvasPngToClipboard(
  canvas,
  {
    clipboard = globalThis.navigator?.clipboard,
    ClipboardItemClass = globalThis.ClipboardItem,
  } = {},
) {
  if (!clipboard || typeof clipboard.write !== "function") {
    throw new Error("当前浏览器不支持复制图片到剪贴板");
  }
  if (typeof ClipboardItemClass !== "function") {
    throw new Error("当前浏览器不支持复制图片到剪贴板");
  }

  // Pass the pending PNG directly so clipboard access starts within the click gesture.
  const pngBlob = canvasToPngBlob(canvas);
  const item = new ClipboardItemClass({ "image/png": pngBlob });
  await clipboard.write([item]);
  return pngBlob;
}
