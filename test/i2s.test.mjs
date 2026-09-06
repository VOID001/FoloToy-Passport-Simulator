import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceDmaDeadline,
  decodeDmaChannels,
  decodeI2sFormat,
  emitAudioPacket,
  transferDurationMs,
} from "../public/wasm/i2s.js";

test("decodes the reference firmware active slot as mono DMA", () => {
  assert.equal(decodeDmaChannels(0x08088004, 0x00010001), 1);
  assert.deepEqual(
    decodeI2sFormat({
      conf: 0x08088004,
      conf1: 0x2f3de38f,
      clkmConf: 0x34000027,
      clkmDivConf: 0x003c0001,
      tdmCtrl: 0x00010001,
    }, { sampleRate: 8000, bits: 16, channels: 2 }),
    { sampleRate: 16000, bits: 16, channels: 1 },
  );
});

test("preserves stereo DMA for two active slots", () => {
  assert.equal(decodeDmaChannels(0x08088004, 0x00010003), 2);
});

test("uses total slots when inactive slots remain in DMA", () => {
  assert.equal(decodeDmaChannels(0x08088004, 0x00110001), 2);
});

test("paces TX and RX from each direction's DMA byte rate", () => {
  assert.equal(
    transferDurationMs(480, { sampleRate: 16000, bits: 16, channels: 1 }),
    15,
  );
  assert.equal(
    transferDurationMs(960, { sampleRate: 16000, bits: 16, channels: 2 }),
    15,
  );
});

test("preserves packet length when the audio callback transfers its buffer", () => {
  const bytes = new Uint8Array(480);
  const transferred = emitAudioPacket((packet) => {
    structuredClone(packet.bytes, { transfer: [packet.bytes.buffer] });
  }, { bytes });

  assert.equal(transferred, 480);
  assert.equal(bytes.byteLength, 0);
});

test("advances DMA deadlines without accumulating scheduler jitter", () => {
  assert.equal(advanceDmaDeadline(0, 100, 15), 115);
  assert.equal(advanceDmaDeadline(115, 117, 15), 130);
  assert.equal(advanceDmaDeadline(130, 200, 15), 215);
});

test('format reconfiguration invalidates DMA cursors even when the root address is reused', async () => {
  const { Esp32C3I2S } = await import('../public/wasm/i2s.js');
  const audio = new Esp32C3I2S({}, {__wbg_ptr:0}, 0);
  audio.nextTx = [0, 0x3fcde750, 0];
  audio.txRoots = [0, 0x3fcde37c, 0];
  audio.nextRx = [0x3fcd0000, 0, 0];
  audio.nextTxAt = 1000;
  audio.handleRegisterWrite(0x6002d024, 0x08088000);
  assert.deepEqual(audio.nextTx, [0,0,0]);
  assert.equal(audio.nextTxAt,0);
  assert.equal(audio.nextRx[0],0x3fcd0000);
  audio._readMmio = () => 0x002de37c;
  assert.equal(audio._currentDescriptor(1,'tx',0xe0,audio.nextTx,audio.txRoots), 0x3fcde37c);
});

test('acknowledges DMA IRQs before the next PCM deadline', async () => {
  const { Esp32C3I2S } = await import('../public/wasm/i2s.js');
  const audio = new Esp32C3I2S({}, {__wbg_ptr:0}, 0);
  audio.nextTxAt=115; audio.nextRxAt=115;
  audio._format=()=>({sampleRate:16000,bits:16,channels:1});
  const acknowledged=[];
  audio._serviceDmaIrq=channel=>{acknowledged.push(channel);return false;};
  audio._pumpTx=()=>assert.fail('TX deadline has not arrived');
  audio._pumpRx=()=>assert.fail('RX deadline has not arrived');
  assert.equal(audio.pump(101),0);
  assert.deepEqual(acknowledged,[0,1,2]);
});
