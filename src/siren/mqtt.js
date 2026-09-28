// A tiny MQTT 3.1.1 publisher — just enough to tell zigbee2mqtt to switch a siren
// on or off: CONNECT → CONNACK → PUBLISH (QoS 0/1) → PUBACK → DISCONNECT.

import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

export function encodeLength(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

function str(s) {
  const b = Buffer.from(String(s), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

export function connectPacket({ clientId, username, password, keepAlive = 30 }) {
  let flags = 0x02; // clean session
  const payload = [str(clientId)];
  if (username) {
    flags |= 0x80;
    payload.push(str(username));
    if (password) {
      flags |= 0x40;
      payload.push(str(password));
    }
  }
  const variable = Buffer.concat([str('MQTT'), Buffer.from([0x04, flags, keepAlive >> 8, keepAlive & 0xff])]);
  const body = Buffer.concat([variable, ...payload]);
  return Buffer.concat([Buffer.from([0x10]), encodeLength(body.length), body]);
}

export function publishPacket({ topic, payload, qos = 0, retain = false, packetId = 1 }) {
  const parts = [str(topic)];
  if (qos > 0) {
    const id = Buffer.alloc(2);
    id.writeUInt16BE(packetId);
    parts.push(id);
  }
  parts.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'));
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x30 | (qos << 1) | (retain ? 1 : 0)]), encodeLength(body.length), body]);
}

export const DISCONNECT = Buffer.from([0xe0, 0x00]);

/** Split one packet off the front of a buffer; null when more bytes are needed. */
export function readPacket(buf) {
  if (buf.length < 2) return null;
  let len = 0;
  let mult = 1;
  let i = 1;
  let byte;
  do {
    if (i >= buf.length) return null;
    byte = buf[i++];
    len += (byte & 0x7f) * mult;
    mult *= 128;
  } while (byte & 0x80 && i < 5);
  if (buf.length < i + len) return null;
  return { type: buf[0] >> 4, flags: buf[0] & 0x0f, body: buf.subarray(i, i + len), rest: buf.subarray(i + len) };
}

const CONNACK_ERRORS = {
  1: 'broker ไม่รองรับ MQTT 3.1.1',
  2: 'client id ถูกปฏิเสธ',
  3: 'MQTT broker ไม่พร้อมให้บริการ',
  4: 'ชื่อผู้ใช้หรือรหัสผ่าน MQTT ไม่ถูกต้อง',
  5: 'MQTT ไม่อนุญาต (Not authorized) — ตรวจ MQTT_USERNAME/MQTT_PASSWORD',
};

export function mqttPublish({ url, username, password, topic, payload, qos = 1, retain = false, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error('MQTT_URL ไม่ถูกต้อง ตัวอย่าง: mqtt://192.168.1.5:1883'));
      return;
    }
    const secure = u.protocol === 'mqtts:';
    const host = u.hostname;
    const port = Number(u.port) || (secure ? 8883 : 1883);
    const user = username || decodeURIComponent(u.username);
    const pass = password || decodeURIComponent(u.password);
    const clientId = `nongfon-${crypto.randomBytes(4).toString('hex')}`;
    const packetId = 1 + Math.floor(Math.random() * 60000);

    let buf = Buffer.alloc(0);
    let finished = false;
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: process.env.MQTT_TLS_INSECURE !== '1' })
      : net.connect({ host, port });

    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (err) socket.destroy();
      else socket.end();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`MQTT broker ${host}:${port} ไม่ตอบภายใน ${Math.round(timeoutMs / 1000)} วินาที`)), timeoutMs);

    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.write(connectPacket({ clientId, username: user, password: pass }));
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let pkt;
      while ((pkt = readPacket(buf))) {
        buf = pkt.rest;
        if (pkt.type === 2) {
          const rc = pkt.body[1];
          if (rc !== 0) return finish(new Error(CONNACK_ERRORS[rc] || `MQTT ปฏิเสธการเชื่อมต่อ (รหัส ${rc})`));
          socket.write(publishPacket({ topic, payload, qos, retain, packetId }));
          if (qos === 0) {
            socket.write(DISCONNECT);
            return finish();
          }
        } else if (pkt.type === 4 && pkt.body.readUInt16BE(0) === packetId) {
          socket.write(DISCONNECT);
          return finish();
        }
      }
    });
    socket.on('error', (err) => finish(new Error(`ต่อ MQTT broker ${host}:${port} ไม่ได้ (${err.code || err.message})`)));
    socket.on('close', () => finish(new Error('MQTT broker ตัดการเชื่อมต่อก่อนส่งสำเร็จ')));
  });
}
