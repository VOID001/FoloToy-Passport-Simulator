import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  EthernetNatSession,
  attachNetworkBridge,
  networkBridgeRuntimeOptions,
} from "../network-bridge.mjs";
import {
  ETHER_TYPE_ARP,
  GATEWAY_IP,
  GATEWAY_MAC,
  IP_PROTOCOL_TCP,
  IP_PROTOCOL_UDP,
  buildIpv4Frame,
  buildTcpPacket,
  buildUdpPacket,
  parseEthernetFrame,
  parseIpv4Frame,
  parseTcpPacket,
  parseUdpPacket,
} from "../network-packets.mjs";
import {
  EMULATOR_WIFI_SSID,
  EmulatorNetworkBridge,
  reconnectDelayMs,
  unpackEthernetFrames,
} from "../public/wasm/network.js";

const GUEST_MAC = Uint8Array.of(0x24, 0x6f, 0x28, 0x01, 0x02, 0x03);
const GUEST_IP = Uint8Array.of(192, 168, 4, 2);
const REMOTE_IP = Uint8Array.of(93, 184, 216, 34);

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function maskedClientFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.from(payload);
  assert.ok(data.byteLength < 126);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(data);
  for (let index = 0; index < masked.byteLength; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  return Buffer.concat([
    Buffer.from([0x80 | opcode, 0x80 | data.byteLength]),
    mask,
    masked,
  ]);
}

class FakeUpgradeSocket extends EventEmitter {
  constructor({ respondToHeartbeat = false, respondToPing = false } = {}) {
    super();
    this.respondToHeartbeat = respondToHeartbeat;
    this.respondToPing = respondToPing;
    this.destroyed = false;
    this.ended = false;
    this.writable = true;
    this.writes = [];
  }

  write(data) {
    const bytes = Buffer.from(data);
    this.writes.push(bytes);
    if (this.respondToPing && bytes[0] === 0x89) {
      queueMicrotask(() => {
        if (!this.destroyed) {
          this.emit("data", maskedClientFrame(0x0a));
        }
      });
    }
    if (this.respondToHeartbeat && bytes[0] === 0x81) {
      const length = bytes[1] & 0x7f;
      const offset = length === 126 ? 4 : 2;
      const payloadLength = length === 126 ? bytes.readUInt16BE(2) : length;
      const message = JSON.parse(
        bytes.subarray(offset, offset + payloadLength).toString("utf8"),
      );
      if (message.type === "network-heartbeat") {
        queueMicrotask(() => {
          if (!this.destroyed) {
            this.emit("data", maskedClientFrame(
              0x01,
              JSON.stringify({
                type: "network-heartbeat-ack",
                id: message.id,
              }),
            ));
          }
        });
      }
    }
    return true;
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.writable = false;
    this.emit("close");
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    this.emit("close");
  }
}

function websocketUpgradeRequest(id) {
  return {
    headers: {
      host: "emulator.example",
      origin: "https://emulator.example",
      "sec-websocket-key": Buffer.from(id).toString("base64"),
      "sec-websocket-version": "13",
      upgrade: "websocket",
      "user-agent": "network-test",
      "x-forwarded-for": "203.0.113.10",
      "x-request-id": id,
    },
    method: "GET",
    socket: { remoteAddress: "127.0.0.1" },
    url: "/api/emulator-network",
  };
}

function captureLogger() {
  const records = [];
  return {
    records,
    logger: {
      info(event, fields) {
        records.push({ level: "info", event, ...fields });
      },
      warn(event, fields) {
        records.push({ level: "warn", event, ...fields });
      },
    },
  };
}

function upgrade(server, socket, id) {
  server.emit("upgrade", websocketUpgradeRequest(id), socket, Buffer.alloc(0));
}

function responseStatus(socket) {
  return socket.writes[0]?.toString().match(/^HTTP\/1\.1 (\d+)/)?.[1];
}

function guestTcpFrame({
  sequence,
  acknowledgment = 0,
  flags,
  payload = new Uint8Array(),
  destinationIp = REMOTE_IP,
}) {
  return buildIpv4Frame({
    sourceMac: GUEST_MAC,
    destinationMac: GATEWAY_MAC,
    sourceIp: GUEST_IP,
    destinationIp,
    protocol: IP_PROTOCOL_TCP,
    payload: buildTcpPacket({
      sourceIp: GUEST_IP,
      destinationIp,
      sourcePort: 49152,
      destinationPort: 80,
      sequence,
      acknowledgment,
      flags,
      payload,
    }),
  });
}

test("unpacks the emulator's little-endian length-prefixed Wi-Fi frames", () => {
  const first = Uint8Array.from({ length: 14 }, (_, index) => index);
  const second = Uint8Array.from({ length: 18 }, (_, index) => 30 + index);
  const packed = new Uint8Array(8 + first.length + second.length);
  const view = new DataView(packed.buffer);
  view.setUint32(0, first.length, true);
  packed.set(first, 4);
  view.setUint32(4 + first.length, second.length, true);
  packed.set(second, 8 + first.length);

  assert.equal(EMULATOR_WIFI_SSID, "Emulator Host Bridge");
  assert.deepEqual(unpackEthernetFrames(packed), [first, second]);
  assert.throws(
    () => unpackEthernetFrames(Uint8Array.of(20, 0, 0, 0, 1, 2)),
    /Invalid Wi-Fi Ethernet frame length/,
  );
});

test("bounds reconnect delay with exponential backoff and jitter", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((attempt) => reconnectDelayMs(attempt, () => 1)),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000],
  );
  assert.equal(reconnectDelayMs(3, () => 0), 4000);
  assert.equal(reconnectDelayMs(3, () => 0.5), 6000);
});

test("resets reconnect backoff after success and cancels it when stopped", () => {
  class FakeWebSocket {
    static OPEN = 1;
    static instances = [];

    constructor() {
      this.listeners = new Map();
      this.readyState = 0;
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    emit(type, event = {}) {
      this.listeners.get(type)?.(event);
    }

    send(data) {
      this.sent.push(data);
    }

    close() {
      this.readyState = 3;
      this.emit("close");
    }
  }

  const scheduled = [];
  const cancelled = [];
  const bridge = new EmulatorNetworkBridge(
    { wifi_tx_drain: () => new Uint8Array() },
    {
      url: "wss://emulator.example/api/emulator-network",
      WebSocketClass: FakeWebSocket,
      random: () => 1,
      setTimeout(callback, delayMs) {
        const timer = { callback, delayMs };
        scheduled.push(timer);
        return timer;
      },
      clearTimeout(timer) {
        if (timer) cancelled.push(timer);
      },
    },
  );

  bridge.connect();
  FakeWebSocket.instances[0].emit("close");
  assert.equal(scheduled[0].delayMs, 1000);
  scheduled[0].callback();
  FakeWebSocket.instances[1].emit("close");
  assert.equal(scheduled[1].delayMs, 2000);
  scheduled[1].callback();
  FakeWebSocket.instances[2].readyState = FakeWebSocket.OPEN;
  FakeWebSocket.instances[2].emit("open");
  FakeWebSocket.instances[2].emit("message", {
    data: JSON.stringify({ type: "network-heartbeat", id: 7 }),
  });
  assert.deepEqual(
    JSON.parse(FakeWebSocket.instances[2].sent.at(-1)),
    { type: "network-heartbeat-ack", id: 7 },
  );
  FakeWebSocket.instances[2].emit("close");
  assert.equal(scheduled[2].delayMs, 1000);

  bridge.close();
  assert.equal(cancelled.at(-1), scheduled[2]);
  assert.equal(scheduled.length, 3);
});

test("validates network bridge runtime configuration", () => {
  assert.deepEqual(networkBridgeRuntimeOptions({}), {
    heartbeatMs: 30_000,
    maxSessions: 16,
  });
  assert.deepEqual(networkBridgeRuntimeOptions({
    EMULATOR_NETWORK_HEARTBEAT_MS: "45000",
    EMULATOR_NETWORK_MAX_SESSIONS: "24",
  }), {
    heartbeatMs: 45_000,
    maxSessions: 24,
  });
  for (const invalid of ["0", "-1", "1.5", "invalid", "999999"]) {
    const options = networkBridgeRuntimeOptions({
      EMULATOR_NETWORK_HEARTBEAT_MS: invalid,
      EMULATOR_NETWORK_MAX_SESSIONS: invalid,
    });
    assert.equal(options.heartbeatMs, 30_000);
    assert.equal(options.maxSessions, 16);
  }
});

test("reclaims unresponsive WebSocket sessions and releases capacity", async () => {
  const server = new EventEmitter();
  const { logger, records } = captureLogger();
  attachNetworkBridge(server, { heartbeatMs: 10, logger, maxSessions: 8 });
  const sockets = Array.from(
    { length: 8 },
    (_, index) => new FakeUpgradeSocket({ respondToPing: true }),
  );
  sockets.forEach((socket, index) => upgrade(server, socket, `session-${index}`));
  assert.ok(sockets.every((socket) => responseStatus(socket) === "101"));

  const rejected = new FakeUpgradeSocket();
  upgrade(server, rejected, "session-rejected");
  assert.equal(responseStatus(rejected), "503");
  const capacityLog = records.find(
    (record) => record.request_id === "session-rejected",
  );
  assert.equal(capacityLog.event, "websocket_access");
  assert.equal(capacityLog.session_id, "session-rejected");
  assert.equal(capacityLog.status, 503);
  assert.equal(capacityLog.reason, "session_limit");
  assert.equal(capacityLog.active_sessions, 8);
  assert.equal(capacityLog.max_sessions, 8);

  await wait(35);
  assert.ok(sockets.every((socket) => socket.destroyed));
  assert.equal(
    records.filter((record) => record.event === "network_bridge_session_expired").length,
    8,
  );
  const closed = records.filter(
    (record) => record.event === "network_bridge_session_closed",
  );
  assert.equal(closed.length, 8);
  assert.ok(closed.every((record) => record.reason === "heartbeat_timeout"));
  assert.deepEqual(
    closed.map((record) => record.active_sessions).sort((left, right) => left - right),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  assert.ok(closed.every((record) => record.max_sessions === 8));

  const replacement = new FakeUpgradeSocket();
  upgrade(server, replacement, "session-replacement");
  assert.equal(responseStatus(replacement), "101");
  assert.ok(records.some((record) =>
    record.request_id === "session-replacement" &&
    record.session_id === "session-replacement" &&
    record.active_sessions === 1 &&
    record.max_sessions === 8 &&
    record.heartbeat_ms === 10
  ));
  server.emit("close");
  assert.equal(replacement.destroyed, true);
  assert.ok(records.some((record) =>
    record.session_id === "session-replacement" &&
    record.event === "network_bridge_session_closed" &&
    record.reason === "server_close" &&
    record.active_sessions === 0
  ));
});

test("keeps WebSocket sessions alive when clients answer application heartbeats", async () => {
  const server = new EventEmitter();
  const { logger, records } = captureLogger();
  const socket = new FakeUpgradeSocket({
    respondToHeartbeat: true,
    respondToPing: true,
  });
  attachNetworkBridge(server, { heartbeatMs: 10, logger });
  upgrade(server, socket, "session-responsive");

  await wait(35);
  assert.equal(socket.destroyed, false);
  assert.ok(socket.writes.filter((bytes) => bytes[0] === 0x89).length >= 2);
  assert.equal(
    records.some((record) => record.event === "network_bridge_session_expired"),
    false,
  );

  socket.destroy();
  server.emit("close");
});

test("clears the heartbeat interval exactly once when a session closes", () => {
  const server = new EventEmitter();
  const { logger, records } = captureLogger();
  const timers = [];
  const socket = new FakeUpgradeSocket();
  attachNetworkBridge(server, {
    heartbeatMs: 10,
    logger,
    setIntervalFn(callback, delayMs) {
      const timer = {
        callback,
        clearCount: 0,
        cleared: false,
        delayMs,
        unref() {},
      };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn(timer) {
      timer.clearCount += 1;
      timer.cleared = true;
    },
  });
  upgrade(server, socket, "session-timer-cleanup");
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 10);

  timers[0].callback();
  const writesBeforeClose = socket.writes.length;
  socket.destroy();
  assert.equal(timers[0].clearCount, 1);

  if (!timers[0].cleared) timers[0].callback();
  assert.equal(socket.writes.length, writesBeforeClose);
  assert.equal(
    records.filter((record) => record.event === "network_bridge_session_expired").length,
    0,
  );
  assert.equal(
    records.filter((record) => record.event === "network_bridge_session_closed").length,
    1,
  );
  server.emit("close");
  assert.equal(timers[0].clearCount, 1);
});

test("answers ARP requests for the emulated gateway", () => {
  const request = new Uint8Array(42);
  request.fill(0xff, 0, 6);
  request.set(GUEST_MAC, 6);
  const view = new DataView(request.buffer);
  view.setUint16(12, ETHER_TYPE_ARP);
  view.setUint16(14, 1);
  view.setUint16(16, 0x0800);
  request[18] = 6;
  request[19] = 4;
  view.setUint16(20, 1);
  request.set(GUEST_MAC, 22);
  request.set(GUEST_IP, 28);
  request.set(GATEWAY_IP, 38);

  const sent = [];
  const session = new EthernetNatSession({ sendFrame: (frame) => sent.push(frame) });
  session.receive(request);

  assert.equal(sent.length, 1);
  const ethernet = parseEthernetFrame(sent[0]);
  assert.deepEqual(ethernet.sourceMac, GATEWAY_MAC);
  assert.deepEqual(ethernet.destinationMac, GUEST_MAC);
  assert.equal(new DataView(ethernet.payload.buffer).getUint16(6), 2);
  session.close();
});

test("bridges a guest TCP stream to a host socket", async () => {
  class FakeSocket extends EventEmitter {
    writes = [];
    destroyed = false;
    setNoDelay() {}
    setTimeout() {}
    write(bytes) { this.writes.push(Buffer.from(bytes)); }
    end() {}
    destroy() { this.destroyed = true; }
  }

  const socket = new FakeSocket();
  const sent = [];
  const events = [];
  const session = new EthernetNatSession({
    sendFrame: (frame) => sent.push(frame),
    emitEvent: (event) => events.push(event),
    debugEnabled: true,
    createTcpConnection: ({ host, port }) => {
      assert.equal(host, "93.184.216.34");
      assert.equal(port, 80);
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
    randomUint32: () => 9000,
  });

  session.receive(guestTcpFrame({ sequence: 1000, flags: 0x02 }));
  await nextTurn();
  assert.equal(sent.length, 1);
  let response = parseTcpPacket(parseIpv4Frame(sent.at(-1)).payload);
  assert.equal(response.flags, 0x12);
  assert.equal(response.sequence, 9000);
  assert.equal(response.acknowledgment, 1001);

  session.receive(guestTcpFrame({
    sequence: 1001,
    acknowledgment: 9001,
    flags: 0x10,
  }));
  const request = new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n");
  session.receive(guestTcpFrame({
    sequence: 1001,
    acknowledgment: 9001,
    flags: 0x18,
    payload: request,
  }));
  assert.equal(socket.writes.at(-1).toString(), "GET / HTTP/1.1\r\n\r\n");
  response = parseTcpPacket(parseIpv4Frame(sent.at(-1)).payload);
  assert.equal(response.acknowledgment, 1001 + request.byteLength);

  socket.emit("data", Buffer.from("HTTP/1.1 204 No Content\r\n\r\n"));
  response = parseTcpPacket(parseIpv4Frame(sent.at(-1)).payload);
  assert.equal(response.sequence, 9001);
  assert.match(new TextDecoder().decode(response.payload), /^HTTP\/1\.1 204/);
  assert.ok(events.some((event) => event.event === "connection-open"));
  session.close();
  assert.equal(socket.destroyed, true);
});

test("blocks guest TCP connections to private destinations by default", () => {
  const sent = [];
  let connected = false;
  const session = new EthernetNatSession({
    sendFrame: (frame) => sent.push(frame),
    createTcpConnection: () => {
      connected = true;
    },
  });
  session.receive(guestTcpFrame({
    sequence: 2000,
    flags: 0x02,
    destinationIp: Uint8Array.of(127, 0, 0, 1),
  }));

  assert.equal(connected, false);
  const response = parseTcpPacket(parseIpv4Frame(sent[0]).payload);
  assert.equal(response.flags, 0x14);
  session.close();
});

test("suppresses connection events until network debugging is enabled", () => {
  const events = [];
  const session = new EthernetNatSession({
    sendFrame: () => {},
    emitEvent: (event) => events.push(event),
  });
  const blocked = guestTcpFrame({
    sequence: 2000,
    flags: 0x02,
    destinationIp: Uint8Array.of(127, 0, 0, 1),
  });

  session.receive(blocked);
  assert.equal(events.length, 0);
  session.setDebugEnabled(true);
  session.receive(blocked);
  assert.equal(events.at(-1).event, "connection-blocked");
  session.close();
});

test("forwards gateway DNS packets and restores the emulated source address", () => {
  class FakeUdpSocket extends EventEmitter {
    sent = [];
    send(payload, port, address) {
      this.sent.push({ payload: Buffer.from(payload), port, address });
    }
    close() {}
  }

  const socket = new FakeUdpSocket();
  const sent = [];
  const session = new EthernetNatSession({
    sendFrame: (frame) => sent.push(frame),
    createUdpSocket: () => socket,
    dnsServer: "1.1.1.1",
  });
  const query = Uint8Array.of(0x12, 0x34, 0x01, 0x00);
  const frame = buildIpv4Frame({
    sourceMac: GUEST_MAC,
    destinationMac: GATEWAY_MAC,
    sourceIp: GUEST_IP,
    destinationIp: GATEWAY_IP,
    protocol: IP_PROTOCOL_UDP,
    payload: buildUdpPacket({
      sourceIp: GUEST_IP,
      destinationIp: GATEWAY_IP,
      sourcePort: 53000,
      destinationPort: 53,
      payload: query,
    }),
  });

  session.receive(frame);
  assert.deepEqual(socket.sent[0], {
    payload: Buffer.from(query),
    port: 53,
    address: "1.1.1.1",
  });

  const answer = Buffer.from([0x12, 0x34, 0x81, 0x80]);
  socket.emit("message", answer);
  const responseIp = parseIpv4Frame(sent[0]);
  const responseUdp = parseUdpPacket(responseIp.payload);
  assert.deepEqual(responseIp.sourceIp, GATEWAY_IP);
  assert.equal(responseUdp.sourcePort, 53);
  assert.equal(responseUdp.destinationPort, 53000);
  assert.deepEqual(responseUdp.payload, new Uint8Array(answer));
  session.close();
});
