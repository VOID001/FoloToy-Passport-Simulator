import assert from "node:assert/strict";
import test from "node:test";

import {
  UartConsoleBuffer,
  encodeUartCommand,
  normalizeUartText,
} from "../public/uart-console.js";

test("normalizes terminal control sequences and line endings", () => {
  assert.equal(
    normalizeUartText("\u001b[0;32mready\u001b[0m\r\nnext\rline\u0000"),
    "ready\nnext\nline",
  );
});

test("keeps the newest complete UART lines within the buffer limit", () => {
  const buffer = new UartConsoleBuffer({ maxChars: 12 });
  buffer.append("one\ntwo\n");
  const snapshot = buffer.append("three\nfour\n");

  assert.equal(snapshot.text, "three\nfour\n");
  assert.equal(snapshot.lineCount, 2);
  assert.ok(snapshot.droppedChars > 0);
});

test("encodes console commands with a carriage-return terminator", () => {
  assert.deepEqual(
    [...encodeUartCommand("help")],
    [...new TextEncoder().encode("help\r")],
  );
});

test("clear resets UART text and counters", () => {
  const buffer = new UartConsoleBuffer();
  buffer.append("boot\n");

  assert.deepEqual(buffer.clear(), {
    text: "",
    lineCount: 0,
    totalBytes: 0,
    droppedChars: 0,
  });
});
