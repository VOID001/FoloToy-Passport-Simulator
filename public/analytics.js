const UMAMI_SCRIPT_URL = "https://cloud.umami.is/script.js";
const UMAMI_SCRIPT_ID = "umami-analytics";

export function loadAnalytics(config, documentRef = document) {
  if (
    config?.provider !== "umami" ||
    typeof config.websiteId !== "string" ||
    documentRef.querySelector(`#${UMAMI_SCRIPT_ID}`)
  ) {
    return false;
  }

  const script = documentRef.createElement("script");
  script.id = UMAMI_SCRIPT_ID;
  script.defer = true;
  script.crossOrigin = "anonymous";
  script.src = UMAMI_SCRIPT_URL;
  script.dataset.websiteId = config.websiteId;
  documentRef.head.append(script);
  return true;
}
