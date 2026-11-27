import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import dgram from 'node:dgram';

const STUN_MAGIC_COOKIE = 0x2112a442;
const METHOD_BINDING = 0x0001;
const METHOD_ALLOCATE = 0x0003;
const METHOD_REFRESH = 0x0004;
const METHOD_SEND = 0x0006;
const METHOD_DATA = 0x0007;
const METHOD_CREATE_PERMISSION = 0x0008;
const METHOD_CHANNEL_BIND = 0x0009;

const MSG_BINDING_REQUEST = 0x0001;
const MSG_ALLOCATE_REQUEST = 0x0003;
const MSG_REFRESH_REQUEST = 0x0004;
const MSG_CREATE_PERMISSION_REQUEST = 0x0008;
const MSG_CHANNEL_BIND_REQUEST = 0x0009;
const MSG_SEND_INDICATION = 0x0016;
const MSG_DATA_INDICATION = 0x0017;

const ATTR_USERNAME = 0x0006;
const ATTR_MESSAGE_INTEGRITY = 0x0008;
const ATTR_ERROR_CODE = 0x0009;
const ATTR_CHANNEL_NUMBER = 0x000c;
const ATTR_LIFETIME = 0x000d;
const ATTR_XOR_PEER_ADDRESS = 0x0012;
const ATTR_DATA = 0x0013;
const ATTR_REALM = 0x0014;
const ATTR_NONCE = 0x0015;
const ATTR_XOR_RELAYED_ADDRESS = 0x0016;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_FINGERPRINT = 0x8028;

const DEFAULT_REALM = 'shipri.local';

function pad4(len) {
  return (4 - (len % 4)) % 4;
}

function encodeXorAddress(address, port) {
  const parts = address.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`Unsupported non-IPv4 address for local TURN stub: ${address}`);
  }
  const buf = Buffer.alloc(8);
  buf[0] = 0x00;
  buf[1] = 0x01;
  buf.writeUInt16BE((port ^ (STUN_MAGIC_COOKIE >>> 16)) & 0xffff, 2);
  const ipNum =
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  buf.writeUInt32BE((ipNum ^ STUN_MAGIC_COOKIE) >>> 0, 4);
  return buf;
}

function decodeXorAddress(buf) {
  if (buf.length < 8 || buf[1] !== 0x01) {
    return null;
  }
  const port = buf.readUInt16BE(2) ^ (STUN_MAGIC_COOKIE >>> 16);
  const rawIp = (buf.readUInt32BE(4) ^ STUN_MAGIC_COOKIE) >>> 0;
  const address = `${(rawIp >>> 24) & 0xff}.${(rawIp >>> 16) & 0xff}.${(rawIp >>> 8) & 0xff}.${rawIp & 0xff}`;
  return { address, port };
}

function buildAttribute(type, valueBuf) {
  const pad = pad4(valueBuf.length);
  const out = Buffer.alloc(4 + valueBuf.length + pad);
  out.writeUInt16BE(type, 0);
  out.writeUInt16BE(valueBuf.length, 2);
  valueBuf.copy(out, 4);
  return out;
}

function encodeErrorCode(code, reason) {
  const cls = Math.floor(code / 100);
  const num = code % 100;
  const reasonBuf = Buffer.from(reason, 'utf8');
  const out = Buffer.alloc(4 + reasonBuf.length);
  out[0] = 0;
  out[1] = 0;
  out[2] = cls & 0x07;
  out[3] = num & 0xff;
  reasonBuf.copy(out, 4);
  return out;
}

function computeCrc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildStunMessage(msgType, transactionId, attrs, integrityKey = null) {
  const attrBufs = attrs.map(({ type, value }) => buildAttribute(type, value));
  let body = Buffer.concat(attrBufs);

  if (integrityKey) {
    const miPlaceholderLen = body.length + 24;
    const preMi = Buffer.alloc(20 + body.length);
    preMi.writeUInt16BE(msgType, 0);
    preMi.writeUInt16BE(miPlaceholderLen, 2);
    preMi.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
    transactionId.copy(preMi, 8, 0, 12);
    body.copy(preMi, 20);
    const hmac = createHmac('sha1', integrityKey).update(preMi).digest();
    body = Buffer.concat([body, buildAttribute(ATTR_MESSAGE_INTEGRITY, hmac)]);
  }

  const fpBodyLen = body.length + 8;
  const preFp = Buffer.alloc(20 + body.length);
  preFp.writeUInt16BE(msgType, 0);
  preFp.writeUInt16BE(fpBodyLen, 2);
  preFp.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(preFp, 8, 0, 12);
  body.copy(preFp, 20);
  const fpVal = Buffer.alloc(4);
  fpVal.writeUInt32BE((computeCrc32(preFp) ^ 0x5354554e) >>> 0, 0);

  return Buffer.concat([preFp, buildAttribute(ATTR_FINGERPRINT, fpVal)]);
}

function parseStunAttributes(packet) {
  const msgLen = packet.readUInt16BE(2);
  const limit = Math.min(packet.length, 20 + msgLen);
  const attrs = [];
  let offset = 20;
  while (offset + 4 <= limit) {
    const type = packet.readUInt16BE(offset);
    const len = packet.readUInt16BE(offset + 2);
    const valStart = offset + 4;
    const valEnd = valStart + len;
    if (valEnd > limit) {
      return null;
    }
    attrs.push({
      type,
      value: packet.subarray(valStart, valEnd),
      offset,
    });
    offset = valEnd + pad4(len);
  }
  return attrs;
}

function deriveLongTermKey(username, realm, turnSharedSecret) {
  const password = createHmac('sha1', turnSharedSecret)
    .update(username)
    .digest('base64');
  return createHash('md5')
    .update(`${username}:${realm}:${password}`, 'utf8')
    .digest();
}

function verifyLongTermAuth(packet, attrs, expectedRealm, expectedNonce, turnSharedSecret) {
  const usernameAttr = attrs.find((a) => a.type === ATTR_USERNAME);
  const realmAttr = attrs.find((a) => a.type === ATTR_REALM);
  const nonceAttr = attrs.find((a) => a.type === ATTR_NONCE);
  const miAttr = attrs.find((a) => a.type === ATTR_MESSAGE_INTEGRITY);

  if (!usernameAttr || !realmAttr || !nonceAttr || !miAttr || miAttr.value.length !== 20) {
    return { ok: false, code: 401, reason: 'Unauthorized' };
  }

  const username = usernameAttr.value.toString('utf8');
  const realm = realmAttr.value.toString('utf8');
  const nonce = nonceAttr.value.toString('utf8');
  if (realm !== expectedRealm || nonce !== expectedNonce) {
    return { ok: false, code: 438, reason: 'Stale Nonce' };
  }

  const expiryRaw = Number.parseInt(username.split(':')[0], 10);
  if (!Number.isSafeInteger(expiryRaw) || Math.floor(Date.now() / 1000) >= expiryRaw) {
    return { ok: false, code: 401, reason: 'Unauthorized' };
  }

  const key = deriveLongTermKey(username, realm, turnSharedSecret);
  const signedSlice = Buffer.from(packet.subarray(0, miAttr.offset));
  signedSlice.writeUInt16BE(miAttr.offset + 24 - 20, 2);
  const expectedMi = createHmac('sha1', key).update(signedSlice).digest();

  if (!timingSafeEqual(expectedMi, miAttr.value)) {
    return { ok: false, code: 401, reason: 'Unauthorized' };
  }

  return { ok: true, key };
}

/**
 * Starts an ephemeral RFC 5389 / RFC 5766 local UDP STUN + authenticated TURN
 * relay server on 127.0.0.1 for Chromium forced-TURN E2E testing without coturn.
 */
export async function startLocalTurnServer({
  turnSharedSecret,
  realm = DEFAULT_REALM,
} = {}) {
  if (typeof turnSharedSecret !== 'string' || turnSharedSecret.length === 0) {
    throw new TypeError('Expected non-empty turnSharedSecret for local TURN server.');
  }

  const mainSocket = dgram.createSocket('udp4');
  const nonce = randomBytes(12).toString('hex');
  const allocations = new Map();
  let closed = false;

  const stats = {
    bindingRequests: 0,
    allocationsCreated: 0,
    permissionsInstalled: 0,
    channelBinds: 0,
    relayedPacketsOut: 0,
    relayedBytesOut: 0,
    relayedPacketsIn: 0,
    relayedBytesIn: 0,
  };

  function clientKey(rinfo) {
    return `${rinfo.address}:${rinfo.port}`;
  }

  function sendChallengeOrError(msgType, txId, rinfo, code, reason) {
    const errType = (msgType & 0xfeef) | 0x0110;
    const response = buildStunMessage(errType, txId, [
      { type: ATTR_ERROR_CODE, value: encodeErrorCode(code, reason) },
      { type: ATTR_REALM, value: Buffer.from(realm, 'utf8') },
      { type: ATTR_NONCE, value: Buffer.from(nonce, 'utf8') },
    ]);
    mainSocket.send(response, rinfo.port, rinfo.address);
  }

  function closeAllocation(key) {
    const alloc = allocations.get(key);
    if (!alloc) {
      return;
    }
    allocations.delete(key);
    try {
      alloc.relaySocket.close();
    } catch {
      // Ignore already closed socket
    }
  }

  mainSocket.on('message', async (packet, rinfo) => {
    if (closed || packet.length < 4) {
      return;
    }

    // ChannelData framing: first 2 bits are 01 (0x4000..0x7fff)
    if ((packet[0] & 0xc0) === 0x40) {
      const channelNumber = packet.readUInt16BE(0);
      const dataLength = packet.readUInt16BE(2);
      if (packet.length < 4 + dataLength) {
        return;
      }
      const alloc = allocations.get(clientKey(rinfo));
      if (!alloc) {
        return;
      }
      const peer = alloc.channelsByNum.get(channelNumber);
      if (!peer || !alloc.permissions.has(peer.address)) {
        return;
      }
      const payload = packet.subarray(4, 4 + dataLength);
      stats.relayedPacketsOut += 1;
      stats.relayedBytesOut += payload.length;
      alloc.relaySocket.send(payload, peer.port, peer.address);
      return;
    }

    if ((packet[0] & 0xc0) !== 0x00 || packet.length < 20) {
      return;
    }
    if (packet.readUInt32BE(4) !== STUN_MAGIC_COOKIE) {
      return;
    }

    const msgType = packet.readUInt16BE(0);
    const txId = packet.subarray(8, 20);
    const attrs = parseStunAttributes(packet);
    if (!attrs) {
      return;
    }

    if (msgType === MSG_BINDING_REQUEST) {
      stats.bindingRequests += 1;
      const response = buildStunMessage(0x0101, txId, [
        {
          type: ATTR_XOR_MAPPED_ADDRESS,
          value: encodeXorAddress(rinfo.address, rinfo.port),
        },
      ]);
      mainSocket.send(response, rinfo.port, rinfo.address);
      return;
    }

    if (msgType === MSG_SEND_INDICATION) {
      const alloc = allocations.get(clientKey(rinfo));
      if (!alloc) {
        return;
      }
      const peerAttr = attrs.find((a) => a.type === ATTR_XOR_PEER_ADDRESS);
      const dataAttr = attrs.find((a) => a.type === ATTR_DATA);
      const peer = peerAttr ? decodeXorAddress(peerAttr.value) : null;
      if (!peer || !dataAttr || !alloc.permissions.has(peer.address)) {
        return;
      }
      stats.relayedPacketsOut += 1;
      stats.relayedBytesOut += dataAttr.value.length;
      alloc.relaySocket.send(dataAttr.value, peer.port, peer.address);
      return;
    }

    const auth = verifyLongTermAuth(packet, attrs, realm, nonce, turnSharedSecret);
    if (!auth.ok) {
      sendChallengeOrError(msgType, txId, rinfo, auth.code, auth.reason);
      return;
    }

    const keyId = clientKey(rinfo);

    if (msgType === MSG_ALLOCATE_REQUEST) {
      const existing = allocations.get(keyId);
      if (existing) {
        existing.key = auth.key;
        const okResp = buildStunMessage(
          0x0103,
          txId,
          [
            {
              type: ATTR_XOR_RELAYED_ADDRESS,
              value: encodeXorAddress('127.0.0.1', existing.relayPort),
            },
            {
              type: ATTR_XOR_MAPPED_ADDRESS,
              value: encodeXorAddress(rinfo.address, rinfo.port),
            },
            { type: ATTR_LIFETIME, value: Buffer.from([0, 0, 2, 0x58]) },
          ],
          auth.key,
        );
        mainSocket.send(okResp, rinfo.port, rinfo.address);
        return;
      }

      const relaySocket = dgram.createSocket('udp4');
      await new Promise((resolve, reject) => {
        relaySocket.once('error', reject);
        relaySocket.bind(0, '127.0.0.1', () => {
          relaySocket.removeListener('error', reject);
          resolve();
        });
      });
      if (closed) {
        relaySocket.close();
        return;
      }

      const relayPort = relaySocket.address().port;
      const alloc = {
        relaySocket,
        relayPort,
        clientAddress: rinfo.address,
        clientPort: rinfo.port,
        key: auth.key,
        permissions: new Set(),
        channelsByNum: new Map(),
        channelsByPeer: new Map(),
      };
      allocations.set(keyId, alloc);
      stats.allocationsCreated += 1;

      relaySocket.on('message', (peerData, peerInfo) => {
        if (closed || !alloc.permissions.has(peerInfo.address)) {
          return;
        }
        stats.relayedPacketsIn += 1;
        stats.relayedBytesIn += peerData.length;

        const pKey = `${peerInfo.address}:${peerInfo.port}`;
        const boundChannel = alloc.channelsByPeer.get(pKey);
        if (boundChannel !== undefined) {
          const frame = Buffer.alloc(4 + peerData.length);
          frame.writeUInt16BE(boundChannel, 0);
          frame.writeUInt16BE(peerData.length, 2);
          peerData.copy(frame, 4);
          mainSocket.send(frame, alloc.clientPort, alloc.clientAddress);
          return;
        }

        const ind = buildStunMessage(MSG_DATA_INDICATION, randomBytes(12), [
          {
            type: ATTR_XOR_PEER_ADDRESS,
            value: encodeXorAddress(peerInfo.address, peerInfo.port),
          },
          { type: ATTR_DATA, value: peerData },
        ]);
        mainSocket.send(ind, alloc.clientPort, alloc.clientAddress);
      });

      const resp = buildStunMessage(
        0x0103,
        txId,
        [
          {
            type: ATTR_XOR_RELAYED_ADDRESS,
            value: encodeXorAddress('127.0.0.1', relayPort),
          },
          {
            type: ATTR_XOR_MAPPED_ADDRESS,
            value: encodeXorAddress(rinfo.address, rinfo.port),
          },
          { type: ATTR_LIFETIME, value: Buffer.from([0, 0, 2, 0x58]) },
        ],
        auth.key,
      );
      mainSocket.send(resp, rinfo.port, rinfo.address);
      return;
    }

    const alloc = allocations.get(keyId);
    if (!alloc) {
      sendChallengeOrError(msgType, txId, rinfo, 437, 'Allocation Mismatch');
      return;
    }

    if (msgType === MSG_REFRESH_REQUEST) {
      const lifetimeAttr = attrs.find((a) => a.type === ATTR_LIFETIME);
      const requested =
        lifetimeAttr && lifetimeAttr.value.length === 4
          ? lifetimeAttr.value.readUInt32BE(0)
          : 600;
      const granted = requested === 0 ? 0 : Math.min(3600, requested);
      const val = Buffer.alloc(4);
      val.writeUInt32BE(granted, 0);
      const resp = buildStunMessage(
        0x0104,
        txId,
        [{ type: ATTR_LIFETIME, value: val }],
        auth.key,
      );
      mainSocket.send(resp, rinfo.port, rinfo.address);
      if (granted === 0) {
        closeAllocation(keyId);
      }
      return;
    }

    if (msgType === MSG_CREATE_PERMISSION_REQUEST) {
      for (const a of attrs) {
        if (a.type === ATTR_XOR_PEER_ADDRESS) {
          const decoded = decodeXorAddress(a.value);
          if (decoded) {
            alloc.permissions.add(decoded.address);
            stats.permissionsInstalled += 1;
          }
        }
      }
      const resp = buildStunMessage(0x0108, txId, [], auth.key);
      mainSocket.send(resp, rinfo.port, rinfo.address);
      return;
    }

    if (msgType === MSG_CHANNEL_BIND_REQUEST) {
      const chAttr = attrs.find((a) => a.type === ATTR_CHANNEL_NUMBER);
      const peerAttr = attrs.find((a) => a.type === ATTR_XOR_PEER_ADDRESS);
      const peer = peerAttr ? decodeXorAddress(peerAttr.value) : null;
      const channelNumber = chAttr && chAttr.value.length >= 2 ? chAttr.value.readUInt16BE(0) : 0;

      if (!peer || channelNumber < 0x4000 || channelNumber > 0x7fff) {
        sendChallengeOrError(msgType, txId, rinfo, 400, 'Bad Request');
        return;
      }

      alloc.permissions.add(peer.address);
      alloc.channelsByNum.set(channelNumber, peer);
      alloc.channelsByPeer.set(`${peer.address}:${peer.port}`, channelNumber);
      stats.channelBinds += 1;

      const resp = buildStunMessage(0x0109, txId, [], auth.key);
      mainSocket.send(resp, rinfo.port, rinfo.address);
      return;
    }

    // Unsupported method -> fallback Method Not Allowed / Bad Request
    if ((msgType & 0x0110) === 0) {
      sendChallengeOrError(msgType, txId, rinfo, 400, 'Bad Request');
    }
  });

  await new Promise((resolve, reject) => {
    mainSocket.once('error', reject);
    mainSocket.bind(0, '127.0.0.1', () => {
      mainSocket.removeListener('error', reject);
      resolve();
    });
  });

  const { port } = mainSocket.address();
  const stunUrl = `stun:127.0.0.1:${port}`;
  const turnUrl = `turn:127.0.0.1:${port}?transport=udp`;

  async function close() {
    if (closed) {
      return;
    }
    closed = true;
    for (const keyId of [...allocations.keys()]) {
      closeAllocation(keyId);
    }
    await new Promise((resolve) => {
      try {
        mainSocket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  return Object.freeze({
    port,
    stunUrl,
    turnUrl,
    getStats: () => ({
      ...stats,
      activeAllocations: allocations.size,
      activeMethodsSeen: {
        binding: METHOD_BINDING,
        allocate: METHOD_ALLOCATE,
        refresh: METHOD_REFRESH,
        send: METHOD_SEND,
        data: METHOD_DATA,
        createPermission: METHOD_CREATE_PERMISSION,
        channelBind: METHOD_CHANNEL_BIND,
      },
    }),
    close,
  });
}
