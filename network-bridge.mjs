import { createHash, randomBytes } from "node:crypto";
import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";

import {
  defaultLogger,
  errorLogFields,
  requestIdFrom,
} from "./logging.mjs";
import {
  ETHER_TYPE_ARP,
  GATEWAY_IP,
  IP_PROTOCOL_ICMP,
  IP_PROTOCOL_TCP,
  IP_PROTOCOL_UDP,
  buildIpv4Frame,
  buildTcpPacket,
  buildUdpPacket,
  createArpReply,
  createIcmpEchoReply,
  ipToString,
  isPrivateOrReservedIpv4,
  parseEthernetFrame,
  parseIpv4Frame,
  parseTcpPacket,
  parseUdpPacket,
} from "./network-packets.mjs";

const TCP_FIN = 0x01;
const TCP_SYN = 0x02;
const TCP_RST = 0x04;
const TCP_PSH = 0x08;
const TCP_ACK = 0x10;
const TCP_MSS = 1300;
const MAX_TCP_CONNECTIONS = 64;
const MAX_TCP_QUEUED_BYTES = 1024 * 1024;
const TCP_PAUSE_BYTES = 64 * 1024;
const FLOW_IDLE_MS = 120_000;
const RETRANSMIT_MS = 800;
const MAX_RETRANSMITS = 5;
const MAX_WEBSOCKET_PAYLOAD = 2048;
const DEFAULT_MAX_WEBSOCKET_SESSIONS = 16;
const MAX_CONFIGURED_WEBSOCKET_SESSIONS = 256;
const DEFAULT_WEBSOCKET_HEARTBEAT_MS = 30_000;
const MIN_WEBSOCKET_HEARTBEAT_MS = 1_000;
const MAX_WEBSOCKET_HEARTBEAT_MS = 10 * 60_000;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const noOpLogger = Object.freeze({
  info() {},
  warn() {},
});

function boundedInteger(value, fallback, { min, max }) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export function networkBridgeRuntimeOptions(env = process.env) {
  return Object.freeze({
    heartbeatMs: boundedInteger(
      env.EMULATOR_NETWORK_HEARTBEAT_MS,
      DEFAULT_WEBSOCKET_HEARTBEAT_MS,
      { min: MIN_WEBSOCKET_HEARTBEAT_MS, max: MAX_WEBSOCKET_HEARTBEAT_MS },
    ),
    maxSessions: boundedInteger(
      env.EMULATOR_NETWORK_MAX_SESSIONS,
      DEFAULT_MAX_WEBSOCKET_SESSIONS,
      { min: 1, max: MAX_CONFIGURED_WEBSOCKET_SESSIONS },
    ),
  });
}

function sameIp(left, right) {
  return left.every((value, index) => value === right[index]);
}

function sequenceAtOrAfter(value, expected) {
  return ((value - expected) | 0) >= 0;
}

function flowKey(ipv4, sourcePort, destinationPort) {
  return [
    ipToString(ipv4.sourceIp),
    sourcePort,
    ipToString(ipv4.destinationIp),
    destinationPort,
  ].join(":");
}

function selectDnsServer() {
  return dns.getServers().find((address) => net.isIP(address) === 4) || "1.1.1.1";
}

class TcpFlow {
  constructor(session, ipv4, tcp) {
    this.session = session;
    this.guestIp = ipv4.sourceIp;
    this.guestMac = ipv4.sourceMac;
    this.guestPort = tcp.sourcePort;
    this.remoteIp = ipv4.destinationIp;
    this.remoteAddress = ipToString(this.remoteIp);
    this.remotePort = tcp.destinationPort;
    this.guestNext = (tcp.sequence + 1) >>> 0;
    this.hostInitial = session.randomUint32();
    this.hostNext = this.hostInitial;
    this.remoteWindow = tcp.window;
    this.state = "connecting";
    this.queue = [];
    this.queuedBytes = 0;
    this.inFlight = null;
    this.remoteEnded = false;
    this.guestEnded = false;
    this.closed = false;
    this.lastActivity = Date.now();

    this.socket = session.createTcpConnection({
      host: this.remoteAddress,
      port: this.remotePort,
      allowHalfOpen: true,
    });
    this.socket.setNoDelay?.(true);
    this.socket.setTimeout?.(FLOW_IDLE_MS);
    this.socket.on("connect", () => this.#connected());
    this.socket.on("data", (data) => this.#receiveRemote(data));
    this.socket.on("end", () => this.#remoteEnd());
    this.socket.on("timeout", () => this.#fail("timeout"));
    this.socket.on("error", (error) => this.#fail(error.code || "connect error"));
    this.socket.on("close", () => {
      if (!this.closed && !this.remoteEnded) this.#fail("closed");
    });

    session.emitEvent({
      event: "connection-opening",
      protocol: "TCP",
      target: `${this.remoteAddress}:${this.remotePort}`,
    });
  }

  handle(tcp) {
    this.lastActivity = Date.now();
    this.remoteWindow = tcp.window;
    if (tcp.flags & TCP_RST) {
      this.close();
      return;
    }

    if (tcp.flags & TCP_ACK) this.#handleAcknowledgment(tcp.acknowledgment);
    if (this.closed) return;

    if (tcp.payload.byteLength) {
      if (tcp.sequence === this.guestNext) {
        this.guestNext = (this.guestNext + tcp.payload.byteLength) >>> 0;
        this.socket.write(Buffer.from(tcp.payload));
      }
      this.#sendSegment(TCP_ACK);
    }

    if (tcp.flags & TCP_FIN) {
      const finSequence = (tcp.sequence + tcp.payload.byteLength) >>> 0;
      if (finSequence === this.guestNext) {
        this.guestNext = (this.guestNext + 1) >>> 0;
      }
      this.guestEnded = true;
      this.#sendSegment(TCP_ACK);
      this.socket.end();
      if (this.remoteEnded && !this.inFlight) this.close(false);
    }
    this.#pump();
  }

  #connected() {
    if (this.closed) return;
    this.state = "syn-sent";
    this.session.emitEvent({
      event: "connection-open",
      protocol: "TCP",
      target: `${this.remoteAddress}:${this.remotePort}`,
    });
    const end = (this.hostNext + 1) >>> 0;
    this.#sendTracked(TCP_SYN | TCP_ACK, new Uint8Array(), end, "syn",
      Uint8Array.of(2, 4, TCP_MSS >>> 8, TCP_MSS & 0xff));
    this.hostNext = end;
  }

  #handleAcknowledgment(acknowledgment) {
    if (!this.inFlight || !sequenceAtOrAfter(acknowledgment, this.inFlight.end)) {
      return;
    }
    clearTimeout(this.inFlight.timer);
    const kind = this.inFlight.kind;
    this.inFlight = null;
    if (kind === "syn") this.state = "established";
    if (kind === "fin") {
      this.close(false);
      return;
    }
    this.#pump();
  }

  #receiveRemote(data) {
    if (this.closed || !data.byteLength) return;
    this.lastActivity = Date.now();
    const bytes = new Uint8Array(data);
    if (this.queuedBytes + bytes.byteLength > MAX_TCP_QUEUED_BYTES) {
      this.#fail("remote response queue limit");
      return;
    }
    for (let offset = 0; offset < bytes.byteLength; offset += TCP_MSS) {
      const chunk = bytes.slice(offset, offset + TCP_MSS);
      this.queue.push(chunk);
      this.queuedBytes += chunk.byteLength;
    }
    if (this.queuedBytes >= TCP_PAUSE_BYTES) this.socket.pause?.();
    this.#pump();
  }

  #remoteEnd() {
    if (this.closed) return;
    this.remoteEnded = true;
    this.#pump();
  }

  #pump() {
    if (
      this.closed ||
      this.state !== "established" ||
      this.inFlight ||
      this.remoteWindow === 0
    ) {
      return;
    }
    const queued = this.queue[0];
    if (queued) {
      const length = Math.min(queued.byteLength, TCP_MSS, this.remoteWindow);
      const payload = queued.slice(0, length);
      if (length === queued.byteLength) this.queue.shift();
      else this.queue[0] = queued.slice(length);
      this.queuedBytes -= length;
      if (this.queuedBytes < TCP_PAUSE_BYTES) this.socket.resume?.();
      const end = (this.hostNext + payload.byteLength) >>> 0;
      this.#sendTracked(TCP_PSH | TCP_ACK, payload, end, "data");
      this.hostNext = end;
      return;
    }
    if (this.remoteEnded) {
      const end = (this.hostNext + 1) >>> 0;
      this.#sendTracked(TCP_FIN | TCP_ACK, new Uint8Array(), end, "fin");
      this.hostNext = end;
    }
  }

  #sendSegment(flags, payload = new Uint8Array(), options = new Uint8Array()) {
    const tcp = buildTcpPacket({
      sourceIp: this.remoteIp,
      destinationIp: this.guestIp,
      sourcePort: this.remotePort,
      destinationPort: this.guestPort,
      sequence: this.hostNext,
      acknowledgment: this.guestNext,
      flags,
      window: 65535,
      payload,
      options,
    });
    return this.session.sendIpv4({
      destinationMac: this.guestMac,
      sourceIp: this.remoteIp,
      destinationIp: this.guestIp,
      protocol: IP_PROTOCOL_TCP,
      payload: tcp,
    });
  }

  #sendTracked(flags, payload, end, kind, options = new Uint8Array()) {
    const frame = this.#sendSegment(flags, payload, options);
    const tracked = { frame, end, kind, attempts: 0, timer: null };
    const retry = () => {
      if (this.closed || this.inFlight !== tracked) return;
      if (tracked.attempts >= MAX_RETRANSMITS) {
        this.#fail("guest acknowledgment timeout");
        return;
      }
      tracked.attempts += 1;
      this.session.sendFrame(frame);
      tracked.timer = setTimeout(retry, RETRANSMIT_MS * tracked.attempts);
      tracked.timer.unref?.();
    };
    tracked.timer = setTimeout(retry, RETRANSMIT_MS);
    tracked.timer.unref?.();
    this.inFlight = tracked;
  }

  #fail(reason) {
    if (this.closed) return;
    this.#sendSegment(TCP_RST | TCP_ACK);
    this.session.emitEvent({
      event: "connection-error",
      protocol: "TCP",
      target: `${this.remoteAddress}:${this.remotePort}`,
      message: reason,
    });
    this.close(true);
  }

  close(destroySocket = true) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.inFlight?.timer);
    if (destroySocket) this.socket.destroy?.();
    this.session.deleteTcpFlow(this);
    this.session.emitEvent({
      event: "connection-close",
      protocol: "TCP",
      target: `${this.remoteAddress}:${this.remotePort}`,
    });
  }
}

export class EthernetNatSession {
  constructor(options) {
    this.sendFrame = options.sendFrame;
    this.eventSink = options.emitEvent ?? (() => {});
    this.logger = options.logger ?? noOpLogger;
    this.sessionId = options.sessionId;
    this.debugEnabled = Boolean(options.debugEnabled);
    this.emitEvent = (event) => {
      if (event.event === "connection-error") {
        this.logger.warn("network_bridge_connection_failed", {
          session_id: this.sessionId,
          protocol: event.protocol,
          target: event.target,
          reason: event.message,
        });
      } else if (event.event === "connection-blocked") {
        this.logger.warn("network_bridge_connection_blocked", {
          session_id: this.sessionId,
          protocol: event.protocol,
          target: event.target,
          reason: event.message,
        });
      }
      if (this.debugEnabled) this.eventSink(event);
    };
    this.allowPrivate = options.allowPrivate ?? false;
    this.createTcpConnection = options.createTcpConnection ?? net.createConnection;
    this.createUdpSocket = options.createUdpSocket ?? (() => dgram.createSocket("udp4"));
    this.dnsServer = options.dnsServer ?? selectDnsServer();
    this.randomUint32 = options.randomUint32 ??
      (() => randomBytes(4).readUInt32BE(0));
    this.tcpFlows = new Map();
    this.udpFlows = new Map();
    this.identification = 1;
    this.closed = false;
  }

  setDebugEnabled(enabled) {
    this.debugEnabled = Boolean(enabled);
  }

  receive(frame) {
    if (this.closed) return;
    const ethernet = parseEthernetFrame(frame);
    if (!ethernet) return;
    if (ethernet.etherType === ETHER_TYPE_ARP) {
      const reply = createArpReply(frame);
      if (reply) this.sendFrame(reply);
      return;
    }
    const ipv4 = parseIpv4Frame(frame);
    if (!ipv4) return;
    if (ipv4.protocol === IP_PROTOCOL_ICMP) {
      const reply = createIcmpEchoReply(ipv4);
      if (reply) this.sendFrame(reply);
      return;
    }
    if (ipv4.protocol === IP_PROTOCOL_TCP) this.#receiveTcp(ipv4);
    if (ipv4.protocol === IP_PROTOCOL_UDP) this.#receiveUdp(ipv4);
  }

  sendIpv4(packet) {
    const frame = buildIpv4Frame({
      ...packet,
      identification: this.identification++,
    });
    this.sendFrame(frame);
    return frame;
  }

  deleteTcpFlow(flow) {
    for (const [key, candidate] of this.tcpFlows) {
      if (candidate === flow) this.tcpFlows.delete(key);
    }
  }

  close() {
    this.closed = true;
    for (const flow of this.tcpFlows.values()) flow.close();
    for (const flow of this.udpFlows.values()) {
      clearTimeout(flow.timer);
      flow.socket.close();
    }
    this.tcpFlows.clear();
    this.udpFlows.clear();
  }

  #receiveTcp(ipv4) {
    const tcp = parseTcpPacket(ipv4.payload);
    if (!tcp) return;
    const key = flowKey(ipv4, tcp.sourcePort, tcp.destinationPort);
    let flow = this.tcpFlows.get(key);
    if (!flow) {
      if (!(tcp.flags & TCP_SYN) || (tcp.flags & TCP_ACK)) return;
      if (this.tcpFlows.size >= MAX_TCP_CONNECTIONS) {
        this.#sendTcpReset(ipv4, tcp, "connection limit");
        return;
      }
      if (!this.#targetAllowed(ipv4.destinationIp)) {
        this.#sendTcpReset(ipv4, tcp, "private or reserved destination blocked");
        return;
      }
      flow = new TcpFlow(this, ipv4, tcp);
      this.tcpFlows.set(key, flow);
      return;
    }
    flow.handle(tcp);
  }

  #sendTcpReset(ipv4, tcp, reason) {
    const acknowledgment =
      (tcp.sequence + tcp.payload.byteLength + ((tcp.flags & TCP_SYN) ? 1 : 0)) >>> 0;
    const payload = buildTcpPacket({
      sourceIp: ipv4.destinationIp,
      destinationIp: ipv4.sourceIp,
      sourcePort: tcp.destinationPort,
      destinationPort: tcp.sourcePort,
      sequence: 0,
      acknowledgment,
      flags: TCP_RST | TCP_ACK,
    });
    this.sendIpv4({
      destinationMac: ipv4.sourceMac,
      sourceIp: ipv4.destinationIp,
      destinationIp: ipv4.sourceIp,
      protocol: IP_PROTOCOL_TCP,
      payload,
    });
    this.emitEvent({
      event: "connection-blocked",
      protocol: "TCP",
      target: `${ipToString(ipv4.destinationIp)}:${tcp.destinationPort}`,
      message: reason,
    });
  }

  #receiveUdp(ipv4) {
    const udp = parseUdpPacket(ipv4.payload);
    if (!udp) return;
    const isGatewayDns =
      udp.destinationPort === 53 && sameIp(ipv4.destinationIp, GATEWAY_IP);
    if (!isGatewayDns && !this.#targetAllowed(ipv4.destinationIp)) {
      this.emitEvent({
        event: "connection-blocked",
        protocol: "UDP",
        target: `${ipToString(ipv4.destinationIp)}:${udp.destinationPort}`,
        message: "private or reserved destination blocked",
      });
      return;
    }

    const key = flowKey(ipv4, udp.sourcePort, udp.destinationPort);
    let flow = this.udpFlows.get(key);
    if (!flow) {
      const socket = this.createUdpSocket();
      flow = {
        socket,
        guestIp: ipv4.sourceIp,
        guestMac: ipv4.sourceMac,
        guestPort: udp.sourcePort,
        wireRemoteIp: ipv4.destinationIp,
        wireRemotePort: udp.destinationPort,
        targetAddress: isGatewayDns ? this.dnsServer : ipToString(ipv4.destinationIp),
        targetPort: udp.destinationPort,
        timer: null,
      };
      socket.on("message", (message) => this.#sendUdpReply(flow, message));
      socket.on("error", (error) => {
        this.emitEvent({
          event: "connection-error",
          protocol: "UDP",
          target: `${flow.targetAddress}:${flow.targetPort}`,
          message: error.code || error.message,
        });
        this.#deleteUdpFlow(key);
      });
      this.udpFlows.set(key, flow);
      this.emitEvent({
        event: "connection-open",
        protocol: isGatewayDns ? "DNS" : "UDP",
        target: `${flow.targetAddress}:${flow.targetPort}`,
      });
    }
    this.#touchUdpFlow(key, flow);
    flow.socket.send(
      Buffer.from(udp.payload),
      flow.targetPort,
      flow.targetAddress,
    );
  }

  #sendUdpReply(flow, message) {
    const payload = buildUdpPacket({
      sourceIp: flow.wireRemoteIp,
      destinationIp: flow.guestIp,
      sourcePort: flow.wireRemotePort,
      destinationPort: flow.guestPort,
      payload: new Uint8Array(message),
    });
    this.sendIpv4({
      destinationMac: flow.guestMac,
      sourceIp: flow.wireRemoteIp,
      destinationIp: flow.guestIp,
      protocol: IP_PROTOCOL_UDP,
      payload,
    });
  }

  #touchUdpFlow(key, flow) {
    clearTimeout(flow.timer);
    flow.timer = setTimeout(() => this.#deleteUdpFlow(key), 30_000);
    flow.timer.unref?.();
  }

  #deleteUdpFlow(key) {
    const flow = this.udpFlows.get(key);
    if (!flow) return;
    clearTimeout(flow.timer);
    flow.socket.close();
    this.udpFlows.delete(key);
  }

  #targetAllowed(address) {
    return this.allowPrivate || !isPrivateOrReservedIpv4(address);
  }
}

class WebSocketPeer {
  constructor(socket, head = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = head;
    this.onBinary = () => {};
    this.onText = () => {};
    this.onClose = () => {};
    this.onError = () => {};
    this.onPong = () => {};
    this.closed = false;
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#parse();
    });
    socket.on("end", () => this.#closed("socket_end"));
    socket.on("close", () => this.#closed("socket_close"));
    socket.on("error", (error) => {
      this.onError(error);
      this.#closed("socket_error");
    });
  }

  start() {
    if (this.buffer.byteLength) this.#parse();
  }

  sendBinary(data) {
    this.#sendFrame(0x02, data);
  }

  sendJson(payload) {
    return this.#sendFrame(0x01, Buffer.from(JSON.stringify(payload)));
  }

  ping() {
    return this.#sendFrame(0x09, Buffer.alloc(0));
  }

  close(reason = "peer_close") {
    if (this.closed) return;
    this.#sendFrame(0x08, Buffer.alloc(0));
    this.#closed(reason);
    this.socket.end();
  }

  terminate(reason) {
    if (this.closed) return;
    this.#closed(reason);
    this.socket.destroy();
  }

  #parse() {
    while (this.buffer.byteLength >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const final = Boolean(first & 0x80);
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (!final || !masked) return this.close("protocol_error");
      if (length === 126) {
        if (this.buffer.byteLength < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        return this.close("protocol_error");
      }
      if (length > MAX_WEBSOCKET_PAYLOAD) return this.close("payload_too_large");
      if (this.buffer.byteLength < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      for (let index = 0; index < payload.byteLength; index += 1) {
        payload[index] ^= mask[index % 4];
      }
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x01) this.onText(payload.toString("utf8"));
      else if (opcode === 0x02) this.onBinary(new Uint8Array(payload));
      else if (opcode === 0x08) return this.close("client_close");
      else if (opcode === 0x09) this.#sendFrame(0x0a, payload);
      else if (opcode === 0x0a) this.onPong();
      else return this.close("protocol_error");
    }
  }

  #sendFrame(opcode, data) {
    if (this.closed || !this.socket.writable) return false;
    const payload = Buffer.from(data);
    const header = payload.byteLength < 126
      ? Buffer.from([0x80 | opcode, payload.byteLength])
      : Buffer.from([
          0x80 | opcode,
          126,
          payload.byteLength >>> 8,
          payload.byteLength & 0xff,
        ]);
    this.socket.write(Buffer.concat([header, payload]));
    return true;
  }

  #closed(reason) {
    if (this.closed) return;
    this.closed = true;
    this.onClose(reason);
  }
}

function originMatchesHost(request) {
  if (!request.headers.origin) return false;
  try {
    return new URL(request.headers.origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export function attachNetworkBridge(server, options = {}) {
  const allowPrivate = options.allowPrivate ??
    process.env.EMULATOR_NETWORK_ALLOW_PRIVATE === "1";
  const runtimeOptions = networkBridgeRuntimeOptions(options.env);
  const heartbeatMs = options.heartbeatMs ?? runtimeOptions.heartbeatMs;
  const maxSessions = options.maxSessions ?? runtimeOptions.maxSessions;
  const logger = options.logger ?? defaultLogger;
  const sessions = new Set();
  server.on("close", () => {
    for (const entry of sessions) entry.peer.terminate("server_close");
  });
  server.on("upgrade", (request, socket, head) => {
    const startedAt = performance.now();
    const requestId = requestIdFrom(request.headers["x-request-id"]);
    const accessFields = {
      request_id: requestId,
      method: request.method,
      path: "<invalid>",
      remote_address: request.socket.remoteAddress,
      forwarded_for: request.headers["x-forwarded-for"],
      user_agent: request.headers["user-agent"],
    };
    const rejectUpgrade = (status, reason) => {
      logger.warn("websocket_access", {
        ...accessFields,
        status,
        reason,
        active_sessions: sessions.size,
        max_sessions: maxSessions,
        duration_ms: Math.round(performance.now() - startedAt),
      });
    };
    let requestUrl;
    try {
      requestUrl = new URL(request.url, `http://${request.headers.host}`);
      accessFields.path = requestUrl.pathname;
    } catch (error) {
      rejectUpgrade(400, "invalid_url");
      logger.warn("websocket_upgrade_failed", {
        request_id: requestId,
        ...errorLogFields(error),
      });
      socket.destroy();
      return;
    }
    if (requestUrl.pathname !== "/api/emulator-network") {
      rejectUpgrade(404, "unknown_path");
      socket.destroy();
      return;
    }
    if (sessions.size >= maxSessions) {
      rejectUpgrade(503, "session_limit");
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (
      request.method !== "GET" ||
      request.headers.upgrade?.toLowerCase() !== "websocket" ||
      request.headers["sec-websocket-version"] !== "13" ||
      typeof key !== "string" ||
      !originMatchesHost(request)
    ) {
      rejectUpgrade(403, "invalid_handshake");
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      `X-Request-ID: ${requestId}`,
      "\r\n",
    ].join("\r\n"));
    const peer = new WebSocketPeer(socket, head);
    const session = new EthernetNatSession({
      ...options,
      allowPrivate,
      logger,
      sessionId: requestId,
      sendFrame: (frame) => peer.sendBinary(frame),
      emitEvent: (event) => peer.sendJson(event),
    });
    const entry = {
      heartbeatTimer: null,
      peer,
      session,
    };
    let heartbeatSequence = 0;
    let pendingHeartbeat = null;
    peer.onBinary = (frame) => session.receive(frame);
    peer.onText = (text) => {
      try {
        const message = JSON.parse(text);
        if (message.type === "network-debug") {
          session.setDebugEnabled(message.enabled);
        } else if (
          message.type === "network-heartbeat-ack" &&
          message.id === pendingHeartbeat
        ) {
          pendingHeartbeat = null;
        }
      } catch {
        peer.close();
      }
    };
    peer.onError = (error) => {
      logger.warn("network_bridge_socket_error", {
        session_id: requestId,
        ...errorLogFields(error),
      });
    };
    peer.onClose = (reason) => {
      clearInterval(entry.heartbeatTimer);
      session.close();
      sessions.delete(entry);
      logger.info("network_bridge_session_closed", {
        session_id: requestId,
        reason,
        active_sessions: sessions.size,
        max_sessions: maxSessions,
        duration_ms: Math.round(performance.now() - startedAt),
      });
    };
    sessions.add(entry);
    logger.info("websocket_access", {
      ...accessFields,
      session_id: requestId,
      status: 101,
      active_sessions: sessions.size,
      max_sessions: maxSessions,
      heartbeat_ms: heartbeatMs,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    entry.heartbeatTimer = setInterval(() => {
      if (pendingHeartbeat !== null) {
        logger.warn("network_bridge_session_expired", {
          session_id: requestId,
          reason: "heartbeat_timeout",
          heartbeat_id: pendingHeartbeat,
          heartbeat_type: "application",
          active_sessions: sessions.size,
          max_sessions: maxSessions,
          heartbeat_ms: heartbeatMs,
        });
        peer.terminate("heartbeat_timeout");
        return;
      }
      heartbeatSequence += 1;
      pendingHeartbeat = heartbeatSequence;
      if (
        !peer.ping() ||
        !peer.sendJson({ type: "network-heartbeat", id: pendingHeartbeat })
      ) {
        peer.terminate("socket_unwritable");
      }
    }, heartbeatMs);
    entry.heartbeatTimer.unref?.();
    peer.start();
    peer.sendJson({
      event: "bridge-ready",
      gateway: ipToString(GATEWAY_IP),
      privateTargets: allowPrivate,
    });
  });
  return server;
}
