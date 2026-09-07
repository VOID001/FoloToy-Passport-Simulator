#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const INPUT_SHA256 =
  "cc6e1de345521da73176019cbd0bc2963d71bed80c11fbbb3e57d52fb99ecfc8";
const OUTPUT_SHA256 =
  "1c693687ba9cd7414d7be09c5916306a672029169ad7c2d4acd7629e97bb6b14";

// These offsets are tied to the input hash above. The USB Serial/JTAG
// peripheral is embedded in the ESP32-C3 machine owned by WasmEmulator.
const ESP32C3_MACHINE_OFFSET = 13296;
const ESP32C3_USB_SERIAL_JTAG_OFFSET = 30568;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function sha256(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(result.stderr || `${command} exited with status ${result.status}`);
  }
}

function replaceOnce(source, anchor, replacement, description) {
  const first = source.indexOf(anchor);
  const second = first < 0 ? -1 : source.indexOf(anchor, first + anchor.length);
  if (first < 0 || second >= 0) {
    fail(`${description}: expected one structural anchor`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + anchor.length)}`;
}

const [inputName, outputName] = process.argv.slice(2);
if (!inputName || !outputName) {
  fail("usage: node tools/patch-uart-runtime.mjs INPUT.wasm OUTPUT.wasm");
}

const input = path.resolve(inputName);
const output = path.resolve(outputName);
const inputHash = sha256(input);
if (inputHash !== INPUT_SHA256) {
  fail(`unsupported runtime: expected ${INPUT_SHA256}, got ${inputHash}`);
}

const functionAnchor = `\
  (func (;425;) (type 0) (param i32 i32 i32)
    (local i32 i32 i32 i32 i32 i32 i32 i32 i32 i32)
`;
const functionReplacement = `${functionAnchor}\
    (call $ap_usb_serial_jtag_input
      (local.get 0)
      (local.get 1)
      (local.get 2))
`;

const definitionsAnchor = `\
  (export "memory" (memory 0))
`;
const definitionsReplacement = `\
  (func $ap_usb_serial_jtag_input
    (param $emulator i32) (param $data i32) (param $len i32)
    (local $usb i32)
    (local $index i32)
    (local $capacity i32)
    (local $length i32)
    (local $slot i32)
    (if
      (i32.eqz (local.get $len))
      (then (return)))
    (local.set $usb
      (i32.add
        (local.get $emulator)
        (i32.const ${ESP32C3_USB_SERIAL_JTAG_OFFSET})))
    (if
      (i32.load offset=28 (local.get $usb))
      (then (return)))
    (i32.store offset=28
      (local.get $usb)
      (i32.const -1))
    (block $done
      (loop $copy
        (br_if $done
          (i32.ge_u
            (local.get $index)
            (local.get $len)))
        (local.set $length
          (i32.load offset=44
            (local.get $usb)))
        (local.set $capacity
          (i32.load offset=32
            (local.get $usb)))
        (if
          (i32.eq
            (local.get $length)
            (local.get $capacity))
          (then
            (call 518
              (i32.add
                (local.get $usb)
                (i32.const 32)))
            (local.set $capacity
              (i32.load offset=32
                (local.get $usb)))))
        (local.set $slot
          (i32.add
            (i32.load offset=40
              (local.get $usb))
            (local.get $length)))
        (if
          (i32.ge_u
            (local.get $slot)
            (local.get $capacity))
          (then
            (local.set $slot
              (i32.sub
                (local.get $slot)
                (local.get $capacity)))))
        (i32.store8
          (i32.add
            (i32.load offset=36
              (local.get $usb))
            (local.get $slot))
          (i32.load8_u
            (i32.add
              (local.get $data)
              (local.get $index))))
        (i32.store offset=44
          (local.get $usb)
          (i32.add
            (local.get $length)
            (i32.const 1)))
        (local.set $index
          (i32.add
            (local.get $index)
            (i32.const 1)))
        (br $copy)))
    (i32.store offset=48
      (local.get $usb)
      (i32.or
        (i32.load offset=48
          (local.get $usb))
        (i32.const 4)))
    (i32.store offset=28
      (local.get $usb)
      (i32.const 0))
    (call 310
      (i32.add
        (local.get $emulator)
        (i32.const ${ESP32C3_MACHINE_OFFSET}))
      (i32.const 26)
      (i32.ne
        (i32.and
          (i32.load offset=48
            (local.get $usb))
          (i32.load offset=52
            (local.get $usb)))
        (i32.const 0))))
  (export "memory" (memory 0))
`;

const directory = mkdtempSync(path.join(tmpdir(), "uart-runtime-"));
const wat = path.join(directory, "runtime.wat");
try {
  run("wasm2wat", ["--fold-exprs", input, "-o", wat]);
  let source = readFileSync(wat, "utf8");
  source = replaceOnce(
    source,
    functionAnchor,
    functionReplacement,
    "UART input function",
  );
  source = replaceOnce(
    source,
    definitionsAnchor,
    definitionsReplacement,
    "runtime definitions",
  );
  writeFileSync(wat, source);
  run("wat2wasm", [wat, "-o", output]);
  run("wasm-validate", [output]);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write(`input_sha256=${inputHash}\n`);
const outputHash = sha256(output);
if (outputHash !== OUTPUT_SHA256) {
  fail(`unexpected patched runtime: expected ${OUTPUT_SHA256}, got ${outputHash}`);
}
process.stdout.write(`output_sha256=${outputHash}\n`);
