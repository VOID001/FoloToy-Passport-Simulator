import assert from "node:assert/strict";
import test from "node:test";

import { AiPassportBoard } from "../public/wasm/ai-passport-board.js";

function createBoardHarness() {
  const frames = [];
  const dirtyRegion = { x: 4, y: 6, width: 8, height: 10 };
  const board = Object.create(AiPassportBoard.prototype);
  board.bridge = { drain: () => [] };
  board.display = {
    width: 240,
    height: 320,
    displayOn: true,
    framebuffer: new Uint8ClampedArray(240 * 320 * 4),
    consumeDirtyRegion() {
      return dirtyRegion;
    },
  };
  board.onFrame = (frame) => frames.push(frame);
  return { board, dirtyRegion, frames };
}

test("board drain flushes display updates by default", () => {
  const { board, dirtyRegion, frames } = createBoardHarness();

  board.drain();

  assert.equal(frames.length, 1);
  assert.equal(frames[0].dirtyRegion, dirtyRegion);
});

test("board drain can coalesce display updates until an explicit flush", () => {
  const { board, frames } = createBoardHarness();

  board.drain({ flushFrame: false });
  assert.equal(frames.length, 0);

  board.flushFrame();
  assert.equal(frames.length, 1);
});
