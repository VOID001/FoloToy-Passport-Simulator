import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { EthernetNatSession } from "../network-bridge.mjs";
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
  unpackEthernetFrames,
} from "../public/wasm/network.js";

const GUEST_MAC = Uint8Array.of(0x24, 0x6f, 0x28, 0x01, 0x02, 0x03);
const GUEST_IP = Uint8Array.of(192, 168, 4, 2);
const REMOTE_IP = Uint8Array.of(93, 184, 216, 34);

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
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
