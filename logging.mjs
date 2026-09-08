import { randomUUID } from "node:crypto";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function defaultWrite(level, line) {
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export function createLogger({
  clock = () => new Date(),
  write = defaultWrite,
} = {}) {
  function log(level, event, fields = {}) {
    const details = { ...fields };
    delete details.timestamp;
    delete details.level;
    delete details.event;
    const line = JSON.stringify({
      timestamp: clock().toISOString(),
      level,
      event,
      ...details,
    });
    write(level, line);
  }

  return Object.freeze({
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
  });
}

export const defaultLogger = createLogger();

export function requestIdFrom(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value)
    ? value
    : randomUUID();
}

export function errorLogFields(error, { includeStack = false } = {}) {
  const fields = {
    error_name: String(error?.name || "Error"),
    error_message: String(error?.message || error || "Unknown error"),
  };
  if (error?.code) fields.error_code = String(error.code);
  if (Number.isInteger(error?.status)) fields.error_status = error.status;
  if (typeof error?.retryable === "boolean") fields.retryable = error.retryable;
  if (Number.isInteger(error?.attempts)) fields.attempts = error.attempts;
  if (error?.details && typeof error.details === "object") {
    Object.assign(fields, error.details);
  }
  if (includeStack && error?.stack) fields.error_stack = String(error.stack);
  return fields;
}
