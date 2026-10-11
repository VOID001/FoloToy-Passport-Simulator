import assert from "node:assert/strict";
import test from "node:test";
import { SimulatorSerial } from "../public/serial-api.js";

class FakeRuntime extends EventTarget {
  ready = true;
  writes = [];
  reply;
  sendUart(bytes) {
    if (!this.ready) return false;
    this.writes.push(bytes.slice());
    this.reply?.();
    structuredClone(bytes, { transfer: [bytes.buffer] });
    return true;
  }
  receive(text) { this.dispatchEvent(new CustomEvent("uart", { detail: text })); }
  state(value) { this.dispatchEvent(new CustomEvent("state", { detail: value })); }
}

test("sends UTF-8 commands with chosen terminator without detaching caller data", async () => {
  const runtime = new FakeRuntime(), serial = new SimulatorSerial(runtime);
  const input = new Uint8Array([0, 255, 13]);
  assert.deepEqual(serial.write(input), { sentBytes: 3 });
  assert.deepEqual([...input], [0, 255, 13]);
  assert.equal((await serial.command("AT+名称?", { terminator: "\r\n" })).sentBytes, 12);
  assert.equal(new TextDecoder().decode(runtime.writes[1]), "AT+名称?\r\n");
  serial.dispose();
});

test("matches split replies and catches a synchronous reply after sending", async () => {
  const runtime = new FakeRuntime(), serial = new SimulatorSerial(runtime);
  runtime.receive("old OK\n");
  runtime.reply = () => { runtime.receive("NEW_"); runtime.receive("OK\r\n"); };
  const result = await serial.command("AT", { match: "NEW_OK" });
  assert.equal(result.text, "NEW_OK\r\n");
  assert.ok(!result.text.includes("old"));
  serial.dispose();
});

test("retains bounded output and rejects expired cursors rather than claiming a match", async () => {
  const runtime = new FakeRuntime(), serial = new SimulatorSerial(runtime, { maxChars: 5 });
  const pending = serial.waitFor("never", { timeoutMs: 100 });
  runtime.receive("123456");
  await assert.rejects(pending, /expired/);
  assert.deepEqual(serial.read(), { text: "23456", cursor: 6 });
  assert.throws(() => serial.read({ since: 0 }), /expired/);
  serial.dispose();
});

test("timeouts and aborts are failures, not acknowledgements", async () => {
  const runtime = new FakeRuntime(), serial = new SimulatorSerial(runtime);
  await assert.rejects(serial.command("AT", { match: "OK", timeoutMs: 5 }), /timed out/);
  const controller = new AbortController();
  const pending = serial.waitFor("OK", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(runtime.writes.length, 1);
  serial.dispose();
});

test("reload, clear, and disposal cancel outstanding waits and detach listeners", async () => {
  for (const action of ["reload", "clear", "dispose"]) {
    const runtime = new FakeRuntime(), serial = new SimulatorSerial(runtime);
    const waiting = serial.waitFor("OK");
    if (action === "reload") runtime.state("loading"); else serial[action]();
    await assert.rejects(waiting, /reloaded|cleared|disposed/);
    assert.equal(serial.cursor, 0);
    serial.dispose();
    runtime.receive("private");
    assert.equal(serial.cursor, 0);
    assert.throws(() => serial.write("AT"), /disposed/);
  }
});

test("rejects malformed, oversize, unavailable and competing command requests", async () => {
  const runtime = new FakeRuntime(), serial = new SimulatorSerial(runtime);
  assert.throws(() => serial.write(new Uint8Array(4097)), /4096/);
  assert.throws(() => serial.write({}), /text/);
  await assert.rejects(serial.command("AT\rINJECT"), /one text line/);
  await assert.rejects(serial.command("AT", { terminator: "x" }), /terminator/);
  runtime.ready = false;
  await assert.rejects(serial.command("AT", { match: "OK" }), /not running/);
  runtime.ready = true;
  const waiting = serial.command("AT", { match: "OK" });
  await assert.rejects(serial.command("AT+NEXT", { match: "OK" }), /already awaiting/);
  runtime.receive("OK");
  await waiting;
  serial.dispose();
});

test("pre-aborted commands are not sent and regex state is reset for each chunk", async () => {
  const runtime = new FakeRuntime(), serial = new SimulatorSerial(runtime);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(serial.command("AT", { match: "OK", signal: controller.signal }), /aborted/);
  assert.equal(runtime.writes.length, 0);
  const pattern = /OK/g; pattern.lastIndex = 100;
  const waiting = serial.waitFor(pattern);
  runtime.receive("OK"); await waiting;
  serial.dispose();
});

test("runtime failures reject pending replies and prevent writes until restart", async () => {
  const runtime = new FakeRuntime(), serial = new SimulatorSerial(runtime);
  const waiting = serial.waitFor("OK");
  runtime.dispatchEvent(new CustomEvent("unsupported-feature", { detail: { feature: "ble" } }));
  await assert.rejects(waiting, /unsupported/);
  assert.throws(() => serial.write("AT"), /not running/);
  runtime.state("running");
  serial.write("AT");
  assert.equal(runtime.writes.length, 1);
  serial.dispose();
});
