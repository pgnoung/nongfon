// Bedside mode: an old phone or tablet next to the bed becomes the alarm clock.
import { $, STATUS, api, fmtTime, listen, mountMascot, setTimeZone, statusOf } from '../app.js';
import { moodFor } from '../mascot.js';

const mascot = mountMascot($('[data-mascot]'), { mood: 'sleep', size: 250, idSuffix: 'bed' });

let audio = null;
let wakeLock = null;
let armed = false;
let alarmTimer = null;
let alarmUntil = 0;
let state = null;
let failures = 0;
let lastAlarmKey = '';
let tz = 'Asia/Bangkok';

// ------------------------------------------------------------------ sound (Web Audio siren, no files needed)
function beepPattern(seconds, { soft = false } = {}) {
  if (!audio) return;
  const now = audio.currentTime;
  const gain = audio.createGain();
  gain.gain.value = soft ? 0.18 : 0.55;
  gain.connect(audio.destination);
  const osc = audio.createOscillator();
  osc.type = soft ? 'sine' : 'square';
  const hi = soft ? 880 : 1046;
  const lo = soft ? 660 : 740;
  for (let t = 0; t < seconds; t += 0.5) {
    osc.frequency.setValueAtTime(Math.round(t * 2) % 2 ? lo : hi, now + t);
  }
  osc.connect(gain);
  osc.start(now);
  osc.stop(now + seconds);
}

function startAlarm(seconds, { soft = false } = {}) {
  stopAlarm(false);
  alarmUntil = Date.now() + seconds * 1000;
  document.body.classList.add('alarming');
  document.body.classList.remove('dimmed');
  $('[data-stop]').hidden = false;
  const loop = () => {
    if (Date.now() >= alarmUntil) return stopAlarm(false);
    beepPattern(2, { soft });
    navigator.vibrate?.([400, 150, 400, 150, 400]);
    alarmTimer = setTimeout(loop, 2000);
  };
  loop();
}

function stopAlarm(announce = true) {
  clearTimeout(alarmTimer);
  alarmUntil = 0;
  document.body.classList.remove('alarming');
  $('[data-stop]').hidden = true;
  navigator.vibrate?.(0);
  if (announce) api('/api/siren/stop', { method: 'POST' }).catch(() => {});
}

// ------------------------------------------------------------------ keep the screen awake
async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && armed) keepAwake();
});

$('[data-arm-btn]').addEventListener('click', async () => {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    await audio.resume();
    beepPattern(0.4, { soft: true });
  } catch {
    /* no audio: the screen still flashes */
  }
  await keepAwake();
  armed = true;
  $('[data-arm]').innerHTML = `<p>✅ <b>พร้อมปลุกแล้ว</b> ${wakeLock ? 'หน้าจอจะไม่ดับ' : 'ตั้งเครื่องไม่ให้ล็อกจอด้วยนะคะ'}</p><p class="small">แตะหน้าจอเพื่อหรี่/เพิ่มแสง</p>`;
  $('[data-test]').hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {});
});
$('[data-test]').addEventListener('click', () => {
  beepPattern(2);
});
$('[data-stop]').addEventListener('click', () => stopAlarm(true));

// dim after a minute without touching, tap to wake the screen
let idle = null;
const poke = () => {
  document.body.classList.remove('dimmed');
  clearTimeout(idle);
  idle = setTimeout(() => {
    if (!alarmUntil) document.body.classList.add('dimmed');
  }, 60000);
};
addEventListener('pointerdown', poke);
poke();

// ------------------------------------------------------------------ status
function render() {
  if (!state) return;
  const status = statusOf(state);
  const latest = state.latest;
  const sirenOn = state.siren.on;
  mascot.setMood(sirenOn ? 'alarm' : status === 'normal' ? 'sleep' : moodFor(latest?.status, { paused: state.next.paused, pending: Boolean(state.pending) }));
  const words = {
    normal: 'น้องฝนเฝ้าอยู่ นอนได้เลยนะคะ 💤',
    warning: 'น้ำถึงเส้นเหลืองแล้ว น้องฝนจับตาอยู่',
    critical: 'น้ำถึงเส้นแดง! ตื่นเร็วค่ะ',
    unknown: 'น้องฝนมองไม่ค่อยเห็น ลองดูกล้องหน่อยนะคะ',
    pending: 'เหมือนน้ำจะถึงเส้นแดง กำลังตรวจซ้ำ…',
    paused: 'ตอนนี้พักการตรวจอยู่',
  };
  $('[data-status]').textContent = sirenOn ? '🚨 ไซเรนกำลังดัง!' : words[status] || STATUS[status]?.th || '';
  const level = $('[data-level]');
  level.hidden = !latest;
  if (latest) level.textContent = `ระดับน้ำ ${latest.status === 'unknown' ? '–' : latest.level ?? '–'}/100 · ${STATUS[status]?.th || ''}`;
  const bits = [];
  if (latest) bits.push(`ตรวจล่าสุด ${fmtTime(latest.ts)}`);
  if (state.siren.snoozeUntil) bits.push(`งดเสียงถึง ${fmtTime(state.siren.snoozeUntil)}`);
  if (state.siren.muteLevel) bits.push(`งดเสียงจนน้ำลดต่ำกว่าระดับ${STATUS[state.siren.muteLevel]?.th || ''}`);
  if (!state.settings.browserAlarm) bits.push('⚠️ ปิดเสียงเตือนหน้าข้างเตียงไว้ในหน้าตั้งค่า');
  $('[data-sub]').textContent = bits.join(' · ');

  // start the alarm when the server says the siren is on (or on red with no physical siren)
  const alarmWanted = armed && state.settings.browserAlarm && sirenOn;
  const key = `${state.siren.until}`;
  if (alarmWanted && key !== lastAlarmKey) {
    lastAlarmKey = key;
    startAlarm(Math.max(3, Math.round((state.siren.until - Date.now()) / 1000)));
  }
  if (!sirenOn && alarmUntil) stopAlarm(false);
}

async function refresh() {
  try {
    state = await api('/api/status');
    failures = 0;
    tz = state.site.timezone;
    setTimeZone(tz);
    render();
  } catch {
    failures++;
    if (failures >= 3) {
      $('[data-status]').textContent = '📡 ขาดการเชื่อมต่อกับน้องฝน';
      $('[data-sub]').textContent = 'ตรวจว่าเครื่องที่รันน้องฝนยังเปิดอยู่ และ Wi-Fi ยังต่ออยู่';
      mascot.setMood('confused');
      if (armed && failures % 4 === 3) beepPattern(1, { soft: true });
    }
  }
}

listen({
  siren: (d) => {
    if (d.on && armed && (d.test || state?.settings.browserAlarm)) {
      lastAlarmKey = `${d.until}`;
      startAlarm(Math.max(2, Math.round((d.until - Date.now()) / 1000)), { soft: d.level === 'warning' });
    }
    if (d.on === false) stopAlarm(false);
    refresh();
  },
  reading: refresh,
  status: refresh,
});

function tick() {
  $('[data-clock]').textContent = new Intl.DateTimeFormat('th-TH', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(Date.now());
}
setInterval(tick, 1000);
setInterval(refresh, 30000);
tick();
refresh();
