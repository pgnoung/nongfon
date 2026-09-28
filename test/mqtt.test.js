import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { connectPacket, encodeLength, mqttPublish, publishPacket, readPacket } from '../src/siren/mqtt.js';
import { Siren } from '../src/siren/siren.js';
import { makeStore, spy } from './helpers.js';

test('remaining-length varint', () => {
  assert.deepEqual([...encodeLength(0)], [0]);
  assert.deepEqual([...encodeLength(127)], [127]);
  assert.deepEqual([...encodeLength(128)], [0x80, 0x01]);
  assert.deepEqual([...encodeLength(16383)], [0xff, 0x7f]);
  assert.deepEqual([...encodeLength(16384)], [0x80, 0x80, 0x01]);
});

test('CONNECT packet layout', () => {
  const p = connectPacket({ clientId: 'c1', username: 'u', password: 'p', keepAlive: 30 });
  assert.equal(p[0], 0x10);
  const pkt = readPacket(p);
  assert.equal(pkt.type, 1);
  const body = pkt.body;
  assert.equal(body.subarray(2, 6).toString(), 'MQTT');
  assert.equal(body[6], 4); // protocol level 3.1.1
  assert.equal(body[7], 0x80 | 0x40 | 0x02); // user + pass + clean session
  assert.equal(body.readUInt16BE(8), 30);
});

test('PUBLISH QoS1 carries the packet id', () => {
  const p = publishPacket({ topic: 't/s', payload: '{"alarm":true}', qos: 1, packetId: 7 });
  const pkt = readPacket(p);
  assert.equal(pkt.type, 3);
  assert.equal(pkt.flags, 0x02);
  const tl = pkt.body.readUInt16BE(0);
  assert.equal(pkt.body.subarray(2, 2 + tl).toString(), 't/s');
  assert.equal(pkt.body.readUInt16BE(2 + tl), 7);
  assert.equal(pkt.body.subarray(4 + tl).toString(), '{"alarm":true}');
  assert.equal(readPacket(p.subarray(0, 3)), null); // incomplete
});

/** Minimal broker: checks credentials, acks CONNECT and QoS1 PUBLISH, remembers messages. */
function fakeBroker({ user = 'u', pass = 'p' } = {}) {
  const got = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let pkt;
      while ((pkt = readPacket(buf))) {
        buf = pkt.rest;
        if (pkt.type === 1) {
          const b = pkt.body;
          let i = 10;
          const read = () => {
            const len = b.readUInt16BE(i);
            const s = b.subarray(i + 2, i + 2 + len).toString();
            i += 2 + len;
            return s;
          };
          read(); // client id
          const u = b[7] & 0x80 ? read() : '';
          const pw = b[7] & 0x40 ? read() : '';
          sock.write(Buffer.from([0x20, 0x02, 0x00, u === user && pw === pass ? 0 : 4]));
        } else if (pkt.type === 3) {
          const tl = pkt.body.readUInt16BE(0);
          const topic = pkt.body.subarray(2, 2 + tl).toString();
          const qos = (pkt.flags >> 1) & 3;
          const id = qos ? pkt.body.readUInt16BE(2 + tl) : null;
          const payload = pkt.body.subarray(2 + tl + (qos ? 2 : 0)).toString();
          got.push({ topic, payload, qos });
          if (qos) sock.write(Buffer.from([0x40, 0x02, id >> 8, id & 0xff]));
        }
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, got, port: server.address().port })));
}

test('publishes to a broker with credentials from the URL', async () => {
  const b = await fakeBroker();
  await mqttPublish({ url: `mqtt://u:p@127.0.0.1:${b.port}`, topic: 'zigbee2mqtt/Siren/set', payload: '{"alarm":true}' });
  assert.deepEqual(b.got, [{ topic: 'zigbee2mqtt/Siren/set', payload: '{"alarm":true}', qos: 1 }]);
  b.server.close();
});

test('wrong password gives a clear Thai error', async () => {
  const b = await fakeBroker();
  await assert.rejects(
    mqttPublish({ url: `mqtt://127.0.0.1:${b.port}`, username: 'u', password: 'nope', topic: 't', payload: 'x' }),
    /ชื่อผู้ใช้หรือรหัสผ่าน MQTT ไม่ถูกต้อง/,
  );
  b.server.close();
});

test('unreachable broker fails fast', async () => {
  await assert.rejects(mqttPublish({ url: 'mqtt://127.0.0.1:1', topic: 't', payload: 'x', timeoutMs: 2000 }), /ต่อ MQTT broker/);
  await assert.rejects(mqttPublish({ url: 'not a url', topic: 't', payload: 'x' }), /MQTT_URL/);
});

test('Siren sends ON then OFF, respects snooze, and test mode bypasses settings', async () => {
  const { store } = makeStore();
  const published = [];
  const events = [];
  const notifier = spy({ record: {} });
  const siren = new Siren({
    store, notifier,
    config: { secrets: { mqttUrl: 'mqtt://x', mqttUsername: '', mqttPassword: '', sirenOnUrl: '', sirenOffUrl: '' } },
    broadcast: (e, d) => events.push([e, d]),
    publish: async (o) => published.push(o.payload),
  });
  // disabled by default → nothing physical, but browser alarm (default on) still fires
  let r = await siren.sound({ reason: 'x', level: 'critical', seconds: 1 });
  assert.equal(published.length, 0);
  assert.ok(events.some(([e, d]) => e === 'siren' && d.on));
  store.updateSettings({ sirenEnabled: true });
  r = await siren.sound({ reason: 'x', level: 'critical', seconds: 1 });
  assert.deepEqual(published, ['{"alarm":true}']);
  assert.equal(siren.status().on, true);
  await siren.stop('user');
  assert.deepEqual(published, ['{"alarm":true}', '{"alarm":false}']);
  assert.equal(siren.status().on, false);
  // warning does not sound unless sirenOnWarning
  store.updateSettings({ browserAlarm: false });
  r = await siren.sound({ reason: 'y', level: 'warning' });
  assert.equal(r.skipped, 'disabled');
  // snooze blocks real alarms but not tests
  await siren.snooze(30);
  r = await siren.sound({ reason: 'z', level: 'critical' });
  assert.equal(r.skipped, 'snoozed');
  r = await siren.sound({ reason: 'test', seconds: 1, test: true });
  assert.equal(r.ok, true);
  await siren.stop('auto');
  siren.unsnooze();
  assert.equal(siren.status().snoozeUntil, null);
});
