import { createHash, randomBytes } from "node:crypto";

export const TRAFFIC_ANALYTICS_ENV = "EMULATOR_TRAFFIC_ANALYTICS";

export function trafficAnalyticsEnabled(env = process.env) {
  return env[TRAFFIC_ANALYTICS_ENV] === "1";
}

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0] || "";
  return String(value || "").split(",", 1)[0].trim();
}

function visitorFingerprint(request, salt) {
  const address =
    firstHeaderValue(request.headers["x-forwarded-for"]) ||
    request.socket.remoteAddress ||
    "";
  const userAgent = firstHeaderValue(request.headers["user-agent"]);
  return createHash("sha256")
    .update(salt)
    .update("\0")
    .update(address)
    .update("\0")
    .update(userAgent)
    .digest("hex");
}

export function createTrafficAnalytics({
  clock = () => new Date(),
  logger,
  salt = randomBytes(32),
} = {}) {
  let day = utcDay(clock());
  let pageViews = 0;
  let visitors = new Set();

  function currentDay() {
    const nextDay = utcDay(clock());
    if (nextDay !== day) {
      day = nextDay;
      pageViews = 0;
      visitors = new Set();
    }
    return day;
  }

  function snapshot() {
    return Object.freeze({
      day: currentDay(),
      pv: pageViews,
      uv: visitors.size,
    });
  }

  function record(request) {
    currentDay();
    pageViews += 1;
    const fingerprint = visitorFingerprint(request, salt);
    const newVisitor = !visitors.has(fingerprint);
    visitors.add(fingerprint);
    const stats = snapshot();
    logger?.info("traffic_analytics", {
      ...stats,
      new_visitor: newVisitor,
    });
    return stats;
  }

  return Object.freeze({ record, snapshot });
}
