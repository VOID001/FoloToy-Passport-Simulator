import net from "node:net";

export const ETHER_TYPE_IPV4 = 0x0800;
export const ETHER_TYPE_ARP = 0x0806;
export const IP_PROTOCOL_ICMP = 1;
export const IP_PROTOCOL_TCP = 6;
export const IP_PROTOCOL_UDP = 17;
export const GATEWAY_IP = Uint8Array.of(192, 168, 4, 1);
export const GATEWAY_MAC = Uint8Array.of(0x02, 0x00, 0x00, 0x00, 0x04, 0x01);

export function ipToString(bytes) {
  return [...bytes].join(".");
}

export function ipFromString(address) {
  if (net.isIP(address) !== 4) {
    throw new TypeError(`Expected an IPv4 address: ${address}`);
  }
  return Uint8Array.from(address.split(".").map(Number));
}

export function checksum(bytes, initial = 0) {
  let sum = initial;
  let index = 0;
  for (; index + 1 < bytes.byteLength; index += 2) {
    sum += (bytes[index] << 8) | bytes[index + 1];
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  if (index < bytes.byteLength) sum += bytes[index] << 8;
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

export function parseEthernetFrame(frame) {
  if (!(frame instanceof Uint8Array) || frame.byteLength < 14) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    destinationMac: frame.slice(0, 6),
    sourceMac: frame.slice(6, 12),
    etherType: view.getUint16(12),
    payload: frame.slice(14),
  };
}

export function createArpReply(frame) {
  const ethernet = parseEthernetFrame(frame);
  if (!ethernet || ethernet.etherType !== ETHER_TYPE_ARP) return null;
  const arp = ethernet.payload;
  if (arp.byteLength < 28) return null;
  const view = new DataView(arp.buffer, arp.byteOffset, arp.byteLength);
  if (
    view.getUint16(0) !== 1 ||
    view.getUint16(2) !== ETHER_TYPE_IPV4 ||
    arp[4] !== 6 ||
    arp[5] !== 4 ||
    view.getUint16(6) !== 1
  ) {
    return null;
  }
  const targetIp = arp.subarray(24, 28);
  if (!targetIp.every((value, index) => value === GATEWAY_IP[index])) return null;

  const reply = new Uint8Array(42);
  reply.set(ethernet.sourceMac, 0);
  reply.set(GATEWAY_MAC, 6);
  const replyView = new DataView(reply.buffer);
  replyView.setUint16(12, ETHER_TYPE_ARP);
  replyView.setUint16(14, 1);
  replyView.setUint16(16, ETHER_TYPE_IPV4);
  reply[18] = 6;
  reply[19] = 4;
  replyView.setUint16(20, 2);
  reply.set(GATEWAY_MAC, 22);
  reply.set(GATEWAY_IP, 28);
  reply.set(arp.subarray(8, 14), 32);
  reply.set(arp.subarray(14, 18), 38);
  return reply;
}

export function parseIpv4Frame(frame) {
  const ethernet = parseEthernetFrame(frame);
  if (!ethernet || ethernet.etherType !== ETHER_TYPE_IPV4) return null;
  const packet = ethernet.payload;
  if (packet.byteLength < 20 || packet[0] >>> 4 !== 4) return null;
  const headerLength = (packet[0] & 0x0f) * 4;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const totalLength = view.getUint16(2);
  const fragment = view.getUint16(6);
  if (
    headerLength < 20 ||
    totalLength < headerLength ||
    totalLength > packet.byteLength ||
    (fragment & 0x3fff) !== 0
  ) {
    return null;
  }
  return {
    sourceMac: ethernet.sourceMac,
    destinationMac: ethernet.destinationMac,
    sourceIp: packet.slice(12, 16),
    destinationIp: packet.slice(16, 20),
    protocol: packet[9],
    payload: packet.slice(headerLength, totalLength),
  };
}

function pseudoHeaderSum(sourceIp, destinationIp, protocol, length) {
  let sum = protocol + length;
  for (let index = 0; index < 4; index += 2) {
    sum += (sourceIp[index] << 8) | sourceIp[index + 1];
    sum += (destinationIp[index] << 8) | destinationIp[index + 1];
  }
  return sum;
}

export function buildIpv4Frame({
  sourceMac = GATEWAY_MAC,
  destinationMac,
  sourceIp,
  destinationIp,
  protocol,
  payload,
  identification = 0,
}) {
  const frame = new Uint8Array(14 + 20 + payload.byteLength);
  frame.set(destinationMac, 0);
  frame.set(sourceMac, 6);
  const view = new DataView(frame.buffer);
  view.setUint16(12, ETHER_TYPE_IPV4);
  const ipOffset = 14;
  frame[ipOffset] = 0x45;
  frame[ipOffset + 1] = 0;
  view.setUint16(ipOffset + 2, 20 + payload.byteLength);
  view.setUint16(ipOffset + 4, identification & 0xffff);
  view.setUint16(ipOffset + 6, 0x4000);
  frame[ipOffset + 8] = 64;
  frame[ipOffset + 9] = protocol;
  frame.set(sourceIp, ipOffset + 12);
  frame.set(destinationIp, ipOffset + 16);
  view.setUint16(
    ipOffset + 10,
    checksum(frame.subarray(ipOffset, ipOffset + 20)),
  );
  frame.set(payload, ipOffset + 20);
  return frame;
}

export function parseUdpPacket(packet) {
  if (packet.byteLength < 8) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const length = view.getUint16(4);
  if (length < 8 || length > packet.byteLength) return null;
  return {
    sourcePort: view.getUint16(0),
    destinationPort: view.getUint16(2),
    payload: packet.slice(8, length),
  };
}

export function buildUdpPacket({
  sourceIp,
  destinationIp,
  sourcePort,
  destinationPort,
  payload,
}) {
  const packet = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(packet.buffer);
  view.setUint16(0, sourcePort);
  view.setUint16(2, destinationPort);
  view.setUint16(4, packet.byteLength);
  packet.set(payload, 8);
  const value = checksum(
    packet,
    pseudoHeaderSum(
      sourceIp,
      destinationIp,
      IP_PROTOCOL_UDP,
      packet.byteLength,
    ),
  );
  view.setUint16(6, value || 0xffff);
  return packet;
}

export function parseTcpPacket(packet) {
  if (packet.byteLength < 20) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const headerLength = (packet[12] >>> 4) * 4;
  if (headerLength < 20 || headerLength > packet.byteLength) return null;
  return {
    sourcePort: view.getUint16(0),
    destinationPort: view.getUint16(2),
    sequence: view.getUint32(4),
    acknowledgment: view.getUint32(8),
    flags: packet[13],
    window: view.getUint16(14),
    options: packet.slice(20, headerLength),
    payload: packet.slice(headerLength),
  };
}

export function buildTcpPacket({
  sourceIp,
  destinationIp,
  sourcePort,
  destinationPort,
  sequence,
  acknowledgment,
  flags,
  window = 65535,
  payload = new Uint8Array(),
  options = new Uint8Array(),
}) {
  const paddedOptionsLength = Math.ceil(options.byteLength / 4) * 4;
  const headerLength = 20 + paddedOptionsLength;
  const packet = new Uint8Array(headerLength + payload.byteLength);
  const view = new DataView(packet.buffer);
  view.setUint16(0, sourcePort);
  view.setUint16(2, destinationPort);
  view.setUint32(4, sequence >>> 0);
  view.setUint32(8, acknowledgment >>> 0);
  packet[12] = (headerLength / 4) << 4;
  packet[13] = flags;
  view.setUint16(14, window);
  packet.set(options, 20);
  packet.set(payload, headerLength);
  const value = checksum(
    packet,
    pseudoHeaderSum(
      sourceIp,
      destinationIp,
      IP_PROTOCOL_TCP,
      packet.byteLength,
    ),
  );
  view.setUint16(16, value);
  return packet;
}

export function createIcmpEchoReply(ipv4) {
  if (ipv4.protocol !== IP_PROTOCOL_ICMP || ipv4.payload.byteLength < 8) {
    return null;
  }
  if (ipv4.payload[0] !== 8 || ipv4.payload[1] !== 0) return null;
  const payload = ipv4.payload.slice();
  payload[0] = 0;
  payload[2] = 0;
  payload[3] = 0;
  new DataView(payload.buffer).setUint16(2, checksum(payload));
  return buildIpv4Frame({
    destinationMac: ipv4.sourceMac,
    sourceIp: ipv4.destinationIp,
    destinationIp: ipv4.sourceIp,
    protocol: IP_PROTOCOL_ICMP,
    payload,
  });
}

export function isPrivateOrReservedIpv4(address) {
  const [a, b, c] = address;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}
