#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { SimulatorSerial } from "../public/serial-api.js";
import { validateFirmwareFile } from "../public/firmware.js";
import { HeadlessRuntime } from "./headless-runtime.mjs";
import { framePng } from "./frame-png.mjs";

async function main() {
  const args = process.argv.slice(2), options = {};
  if (!args.length || args.includes("--help")) {
    console.log("Usage: node tools/serial-debug.mjs --firmware FULL.bin --commands-file steps.json [--boot-ms 5000] [--output-dir ./serial-output]\nSteps: [{command:'AT+NET?',match:'CAMPUS_NET',timeoutMs:3000},{command:'ok',settleMs:500,screenshot:'home.png'}]\nEach run starts a fresh offline virtual device. No physical USB devices are opened. Commands are not echoed.");
    return;
  }
  const allowed = new Set(["--firmware", "--commands-file", "--boot-ms", "--output-dir"]);
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || args[i + 1] === undefined || options[args[i]] !== undefined) throw new Error("Invalid or duplicate option");
    options[args[i]] = args[i + 1];
  }
  if (!options["--firmware"] || !options["--commands-file"]) throw new Error("Firmware and commands file are required");
  const firmware = await readFile(options["--firmware"]);
  validateFirmwareFile({ name: options["--firmware"], size: firmware.length });
  const steps = JSON.parse(await readFile(options["--commands-file"], "utf8"));
  if (!Array.isArray(steps) || !steps.length || steps.length > 1000) throw new Error("Expected 1–1000 steps");
  const bootMs = Number(options["--boot-ms"] ?? 5000);
  const outputDir = path.resolve(options["--output-dir"] ?? "serial-output");
  const runtime = await HeadlessRuntime.create(firmware);
  const serial = new SimulatorSerial(runtime);
  try {
    await runtime.runFor(bootMs);
    serial.clear();
    for (const [index, step] of steps.entries()) {
      if (!step || typeof step !== "object" || Array.isArray(step) ||
          Object.keys(step).some((key) => !["command", "terminator", "match", "timeoutMs", "settleMs", "screenshot"].includes(key))) throw new Error("Invalid step schema");
      const since = serial.cursor;
      // Timeout values are virtual milliseconds in this offline runner.
      const duration = step.match === undefined ? (step.settleMs ?? 500) : (step.timeoutMs ?? 3000);
      if (step.match !== undefined && (typeof step.match !== "string" || !step.match)) throw new Error("Expected a nonempty literal response marker");
      await serial.command(step.command, { terminator: step.terminator });
      await runtime.runFor(duration);
      const response = serial.read({ since });
      if (step.match !== undefined && !response.text.includes(step.match)) throw new Error(`Step ${index + 1}: expected serial response was not received`);
      if (step.screenshot !== undefined) {
        if (typeof step.screenshot !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.png$/.test(step.screenshot)) throw new Error("Screenshot must be a PNG basename");
        await mkdir(outputDir, { recursive: true });
        await writeFile(path.join(outputDir, step.screenshot), framePng(runtime.snapshot()));
      }
      console.log(JSON.stringify({ step: index + 1, sent: true, matched: step.match === undefined ? null : true,
        output: response.text, screenshot: step.screenshot ?? null }));
    }
  } finally { serial.dispose(); runtime.dispose(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
