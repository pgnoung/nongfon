// What we ask Claude, and the exact JSON shape we want back.
// The system prompt never changes between checks, so it is cached; anything that
// changes every check (time, current pictures) goes at the end of the message.

export const LINE_STATUS = ['no_lines', 'below_green', 'below_yellow', 'at_yellow', 'at_red', 'cannot_tell'];
export const WATER = ['dry', 'wet_surface', 'puddles', 'flooded'];
export const LEVEL_STATUS = ['normal', 'warning', 'critical', 'unknown'];

export const SYSTEM_PROMPT = `You are Nong Fon (น้องฝน), a careful flood-watch assistant for a Thai household. The family is asleep and trusts you to look at still frames from their own security cameras and report how high any standing water is, relative to lines they drew on each camera.

Reading the pictures
- A camera may show a dashed YELLOW line (warning) and/or a dashed RED line (critical). The owner drew them on the ground, a step, a wall or the gate where water starts to be worrying (yellow) or dangerous (red). A small tag near each line says YELLOW or RED.
- A camera may also show a dashed GREEN line (safe), tagged GREEN, on the far side of the yellow line away from the house. It marks where the water must go back down to before the flood counts as over.
- Compare the edge of the standing water (the waterline) with each line. Water has reached a line only when the continuous water surface touches or crosses that line itself. Water somewhere else in the frame does not count.
- A wet, dark or shiny floor is not standing water. Rain drops on the lens, reflections of lamps and headlights, and puddles that are not connected to the line are not a flood. Real standing water shows a continuous flat surface, a visible edge, ripples, or mirror reflections of nearby objects.
- Night frames are often greyscale infrared, where water may look pale or glowing. Be extra careful at night and say so when you cannot see the waterline clearly.
- When a dry-weather reference photo of the same camera is given, compare with it: kerbs, tiles, steps or tyres that were visible before and are now under a flat surface are strong evidence of water.
- Judge each camera from its own current picture only. Do not assume water in one camera because another camera shows water.

What to report
- cameras: one entry for every camera, using the camera id you were given.
  - line_status:
    - "no_lines": this camera has no lines drawn.
    - "below_green": only for a camera with a green line — the waterline has not gone past the green line (dry, water only on the far side of it, or its edge right at the green line).
    - "below_yellow": no water at the yellow or red line. With a green line: the water is past the green line but still below yellow. Without a green line: dry, water only away from the lines, or water still below the yellow line. If the camera has only a red line, use this for "below the red line".
    - "at_yellow": the waterline has reached or passed the yellow line but not the red line.
    - "at_red": the waterline has reached or passed the red line.
    - "cannot_tell": lines exist but you cannot see where the water edge is (too dark, blurry, blocked, glare, rain on the lens).
  - water: "dry", "wet_surface" (wet but no standing water), "puddles", or "flooded" (a continuous sheet of water).
  - coverage_pct: 0-100, the share of the visible ground in this camera that is under standing water (0 when dry or only wet).
  - note_th: one short Thai sentence, at most 90 characters, about the water in this camera only.
- level: one number 0-100 for the whole property. 0 = completely dry. About 25 = water present but still far from the yellow line (for example only on the street), or water right at a green line. 50 = water at the yellow line. 100 = water at the red line. Use values in between for positions in between. If no red line exists, 100 means the dangerous situation the owner describes. If no lines are drawn anywhere, place the water on this scale using the owner's description of the property. Do not give 100 or more unless the water really reached the red line (or, with no red line, the owner's dangerous situation).
- level_status: your own overall reading — "normal", "warning" (water at or past a yellow line, or clearly on its way), "critical" (water at a red line), or "unknown" when the pictures do not let you judge the water at all (all too dark, blurred, blocked or frozen). When you say "unknown", set level to 0; it will be ignored.
- distance_th: at most 40 Thai characters saying how far the water is from the red line (or from the dangerous spot when there is no red line), for example "ต่ำกว่าเส้นแดงราว 20 ซม." or "ถึงเส้นแดงแล้ว". Use "ไม่แน่ใจ" when you cannot tell.
- confidence: 0-1, how sure you are about level and line_status.
- headline_th: one calm, plain Thai sentence of at most 80 characters that a sleepy person understands at a glance, for example "น้ำท่วมถนนหน้าบ้าน แต่ยังไม่ถึงเส้นเหลือง".
Write the Thai text plainly: facts about water only, no emojis, no greetings, no advice.`;

export const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    cameras: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          line_status: { type: 'string', enum: LINE_STATUS },
          water: { type: 'string', enum: WATER },
          coverage_pct: { type: 'integer' },
          note_th: { type: 'string' },
        },
        required: ['id', 'line_status', 'water', 'coverage_pct', 'note_th'],
        additionalProperties: false,
      },
    },
    level: { type: 'integer' },
    level_status: { type: 'string', enum: LEVEL_STATUS },
    distance_th: { type: 'string' },
    confidence: { type: 'number' },
    headline_th: { type: 'string' },
  },
  required: ['cameras', 'level', 'level_status', 'distance_th', 'confidence', 'headline_th'],
  additionalProperties: false,
};

function lineSummary(lines = {}) {
  const has = (k) => (lines[k] || []).length >= 2;
  const names = [['safe', 'green'], ['warning', 'yellow'], ['critical', 'red']].filter(([k]) => has(k)).map(([, n]) => n);
  if (!has('warning') && !has('critical')) return 'no lines';
  if (names.length === 1) return `${names[0]} line only`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)} lines`;
}

/**
 * Build the user-message content blocks.
 * cameras: [{ id, name, lines, note, reference?: { buffer, kind }, frame?: { buffer, night, timeText } }]
 * Returns { blocks, staticCount } — the first staticCount blocks rarely change (cacheable).
 */
export function buildContent({ siteName, siteDescription, cameras }) {
  const blocks = [];
  const intro = [
    `Property: ${siteName || 'the house'}.`,
    `Owner's description of the property and what the levels mean there: ${siteDescription?.trim() || '(not provided)'}`,
    'Cameras:',
    ...cameras.map((c) => `- id "${c.id}", name "${c.name}": ${lineSummary(c.lines)}.${c.note ? ` Owner's note: ${c.note}` : ''}`),
  ].join('\n');
  blocks.push({ type: 'text', text: intro });

  for (const cam of cameras) {
    if (!cam.reference?.buffer) continue;
    blocks.push({ type: 'text', text: `Dry-weather reference photo for camera "${cam.id}" (${cam.reference.kind === 'night' ? 'night / infrared' : 'daylight'}):` });
    blocks.push(imageBlock(cam.reference.buffer));
  }
  const staticCount = blocks.length;

  const live = cameras.filter((c) => c.frame?.buffer);
  for (const cam of live) {
    const mode = cam.frame.night ? 'night infrared picture' : 'daylight picture';
    blocks.push({ type: 'text', text: `Camera "${cam.id}" (${cam.name}) — current ${mode}, taken ${cam.frame.timeText}:` });
    blocks.push(imageBlock(cam.frame.buffer));
  }
  const missing = cameras.filter((c) => !c.frame?.buffer).map((c) => `"${c.id}"`);
  blocks.push({
    type: 'text',
    text: `Report on these cameras: ${live.map((c) => `"${c.id}"`).join(', ')}.` +
      (missing.length ? ` No picture could be captured from ${missing.join(', ')} this time — do not report on them.` : ''),
  });
  return { blocks, staticCount };
}

export function imageBlock(buffer) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buffer.toString('base64') } };
}
