// น้องฝน — the rain-watch sister in the น้องเก้า universe.
// Chibi helper with a sky bob, a hollow raindrop curl, and a rain-scouter visor
// over her right eye (the picture's LEFT) — the mirror of น้องเก้า's visor, so the
// two sisters pair up when they stand side by side. Her droplet orb is also her
// status light: sky when all is well, amber on the yellow line, red on the red line.
//
// One SVG holds every expression; CSS shows the parts for the current mood:
//   happy · watch (yellow line) · alarm (red line) · confused (can't see) · sleep · relief · scan (re-checking)
// Plain string output, so it works in the browser and in Node (alert pictures via sharp).

export const FON = {
  navy: '#4B4A67',      // cel outline (universe token `navy`)
  ink: '#2F2C46',
  hair: '#9CC6F6',
  hairShade: '#6F9FE3',
  hairLight: '#D9EBFF',
  skin: '#FFEBE1',
  skinShade: '#F8D3C6',
  blush: '#FF9FB4',
  iris: '#3F86E0',
  irisDeep: '#1D3F86',
  coat: '#FFFFFF',
  coatShade: '#E3ECF8',
  trim: '#8BBEF9',       // Fon's own colour ("rain")
  trimDeep: '#4F8BDD',
  dark: '#3A3957',       // skirt / tights / cuffs (universe deep navy)
  cyan: '#82EBFD',       // signal light (universe token `cyan`)
  mouth: '#C8506A',
};

export const MOODS = ['happy', 'watch', 'alarm', 'confused', 'sleep', 'relief', 'scan'];

const O = `stroke="${FON.navy}" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"`;
const O2 = `stroke="${FON.navy}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"`;

// ------------------------------------------------------------------ defs
function defs(id) {
  return `<defs>
    <linearGradient id="hair-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${FON.hairLight}"/><stop offset=".38" stop-color="${FON.hair}"/><stop offset="1" stop-color="${FON.hairShade}"/>
    </linearGradient>
    <linearGradient id="hairBack-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${FON.hair}"/><stop offset="1" stop-color="${FON.hairShade}"/>
    </linearGradient>
    <radialGradient id="iris-${id}" cx=".5" cy=".3" r=".75">
      <stop offset="0" stop-color="#7FB8F7"/><stop offset=".55" stop-color="${FON.iris}"/><stop offset="1" stop-color="${FON.irisDeep}"/>
    </radialGradient>
    <linearGradient id="skin-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${FON.skin}"/><stop offset="1" stop-color="#FFE2D6"/>
    </linearGradient>
    <linearGradient id="coat-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${FON.coat}"/><stop offset="1" stop-color="${FON.coatShade}"/>
    </linearGradient>
    <linearGradient id="lens-${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${FON.cyan}" stop-opacity=".55"/><stop offset="1" stop-color="#5FB4F5" stop-opacity=".32"/>
    </linearGradient>
    <radialGradient id="orb-${id}" cx=".38" cy=".32" r=".75">
      <stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".45" class="orb-mid" stop-color="${FON.trim}" stop-opacity=".85"/><stop offset="1" class="orb-edge" stop-color="${FON.trimDeep}" stop-opacity=".9"/>
    </radialGradient>
    <radialGradient id="glow-${id}" cx=".5" cy=".5" r=".5">
      <stop offset="0" class="glow-in" stop-color="${FON.trim}" stop-opacity=".55"/><stop offset="1" class="glow-out" stop-color="${FON.trim}" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
}

// ------------------------------------------------------------------ body parts
function hairBack(id) {
  return `<path d="M88 160 C84 88 136 44 200 42 C266 44 318 88 312 162 C309 205 318 240 304 276 C292 266 278 264 266 272 C252 262 240 262 228 268 L172 268 C160 262 148 262 134 272 C122 264 108 266 96 276 C82 240 91 205 88 160 Z" fill="url(#hairBack-${id})" ${O}/>`;
}

function hood() {
  // the raincoat hood, folded down behind the shoulders
  return `<path d="M128 292 C132 262 164 250 200 250 C236 250 268 262 272 292 C262 304 240 308 200 308 C160 308 138 304 128 292 Z" fill="${FON.trim}" ${O}/>
    <path d="M150 292 C160 272 182 266 200 266 C218 266 240 272 250 292" fill="none" stroke="${FON.trimDeep}" stroke-width="2.4" stroke-linecap="round" opacity=".7"/>`;
}

function legs() {
  return `<g>
    <path d="M166 398 C163 426 164 452 168 474 L190 474 C192 452 194 426 196 398 Z" fill="${FON.dark}" ${O}/>
    <path d="M204 398 C206 426 208 452 210 474 L232 474 C236 452 237 426 234 398 Z" fill="${FON.dark}" ${O}/>
    <path d="M174 406 C172 426 173 446 175 462 M214 406 C216 426 217 446 218 462" stroke="#5D5C80" stroke-width="3" stroke-linecap="round" opacity=".8"/>
    <path d="M226 420 L234 416 L236 432 L228 434 Z" fill="${FON.trim}" ${O2}/>
  </g>`;
}

function boots() {
  const boot = (x, flip) => {
    const s = flip ? -1 : 1;
    return `<g transform="translate(${x} 0) scale(${s} 1)">
      <path d="M-22 452 C-24 470 -26 484 -28 494 C-18 504 12 505 20 496 C19 482 18 468 16 452 Z" fill="${FON.coat}" ${O}/>
      <path d="M-23 452 L17 452 L17 464 C4 467 -10 467 -23 464 Z" fill="${FON.trim}" ${O2}/>
      <path d="M-28 494 C-18 504 12 505 20 496 L20 500 C12 510 -18 510 -28 500 Z" fill="${FON.dark}" ${O2}/>
      <rect x="-12" y="478" width="16" height="5" rx="2.5" fill="${FON.cyan}" stroke="${FON.navy}" stroke-width="1.6"/>
    </g>`;
  };
  return boot(180, false) + boot(221, true);
}

function skirt() {
  return `<g>
    <path d="M134 360 L266 360 L286 404 C244 418 156 418 114 404 Z" fill="${FON.trim}" ${O}/>
    <path d="M138 352 L262 352 L280 398 C240 410 160 410 120 398 Z" fill="${FON.dark}" ${O}/>
    <path d="M165 356 L156 404 M200 356 L200 408 M235 356 L244 404" stroke="#5D5C80" stroke-width="2.4" stroke-linecap="round"/>
  </g>`;
}

function torso(id) {
  return `<g>
    <path d="M142 280 C154 268 246 268 258 280 L270 356 C236 368 164 368 130 356 Z" fill="url(#coat-${id})" ${O}/>
    <path d="M178 272 L200 312 L222 272" fill="#F3F7FD" ${O2}/>
    <path d="M200 312 L200 360" stroke="${FON.navy}" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M178 272 L166 300 L186 318 L200 312 Z" fill="${FON.trim}" ${O2}/>
    <path d="M222 272 L234 300 L214 318 L200 312 Z" fill="${FON.trim}" ${O2}/>
    <path d="M130 356 C164 368 236 368 270 356 L272 368 C236 382 164 382 128 368 Z" fill="${FON.dark}" ${O2}/>
    <path d="M200 288 C205 296 208 301 208 305 A8 8 0 0 1 192 305 C192 301 195 296 200 288 Z" fill="${FON.cyan}" stroke="${FON.navy}" stroke-width="1.8"/>
    <path d="M250 276 L150 352" stroke="${FON.dark}" stroke-width="9" stroke-linecap="round"/>
    <path d="M250 276 L150 352" stroke="#5D5C80" stroke-width="3" stroke-linecap="round" stroke-dasharray="1 9"/>
    <g transform="translate(138 350)">
      <path d="M0 -20 C9 -8 16 2 16 10 A16 16 0 0 1 -16 10 C-16 2 -9 -8 0 -20 Z" fill="${FON.coat}" ${O2}/>
      <path d="M-14 4 C-6 -2 6 -2 14 4" fill="none" stroke="${FON.trim}" stroke-width="4" stroke-linecap="round"/>
      <circle cy="12" r="3" fill="${FON.cyan}" stroke="${FON.navy}" stroke-width="1.5"/>
    </g>
  </g>`;
}

function hand(x, y, r = 12) {
  return `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 0.92}" fill="${FON.skin}" ${O2}/>`;
}

function sleeve(d, cuff) {
  return `<path d="${d}" fill="url(#coat-SUFFIX)" ${O}/>${cuff}`;
}

/**
 * Arm poses. Each pose is split into a layer behind the head and one in front of
 * the hair (a raised hand must not vanish behind her bob). Both layers carry the
 * same class, so CSS shows or hides a pose as one piece.
 */
function arms(id) {
  const cuff = (x, y, rot) => `<rect x="${x - 14}" y="${y - 8}" width="28" height="16" rx="7" transform="rotate(${rot} ${x} ${y})" fill="${FON.dark}" ${O2}/>`;
  const fix = (str) => str.replaceAll('SUFFIX', id);
  const leftDown = sleeve('M146 284 C128 296 120 324 122 346 L146 346 C146 328 152 310 160 298 Z', cuff(134, 346, 6)) + hand(133, 362);
  const rightDown = sleeve('M254 284 C272 296 280 324 278 346 L254 346 C254 328 248 310 240 298 Z', cuff(266, 346, -6)) + hand(267, 362);
  const rightWave = sleeve('M252 286 C274 282 300 262 312 236 L290 224 C280 246 264 264 244 272 Z', cuff(302, 228, -62))
    + `<g><ellipse cx="318" cy="206" rx="15" ry="17" fill="${FON.skin}" ${O2}/><path d="M307 197 L302 184 M316 192 L315 177 M325 195 L330 182" stroke="${FON.navy}" stroke-width="2.6" stroke-linecap="round"/></g>`;
  const leftOrb = sleeve('M148 286 C126 294 110 312 106 330 L128 338 C132 322 144 308 160 300 Z', cuff(116, 334, 18)) + hand(110, 348);
  const leftVisor = sleeve('M148 286 C122 290 98 266 92 238 L114 228 C120 250 136 266 158 276 Z', cuff(102, 232, 70))
    + `<g><ellipse cx="100" cy="206" rx="14" ry="15" fill="${FON.skin}" ${O2}/><path d="M92 196 L98 186 M102 194 L108 184" stroke="${FON.navy}" stroke-width="2.4" stroke-linecap="round"/></g>`;
  const upL = sleeve('M148 286 C120 276 100 244 96 212 L120 206 C124 234 140 256 160 272 Z', cuff(108, 210, 80)) + hand(106, 188, 14);
  const upR = sleeve('M252 286 C280 276 300 244 304 212 L280 206 C276 234 260 256 240 272 Z', cuff(292, 210, -80)) + hand(294, 188, 14);
  return {
    back: `<g class="arms arms-wave">${fix(leftOrb)}</g>
      <g class="arms arms-down">${fix(leftDown + rightDown)}</g>
      <g class="arms arms-visor">${fix(rightDown)}</g>`,
    front: `<g class="arms arms-wave">${fix(rightWave)}</g>
      <g class="arms arms-visor">${fix(leftVisor)}</g>
      <g class="arms arms-up">${fix(upL + upR)}</g>`,
  };
}

function head(id) {
  return `<g>
    <path d="M186 246 L214 246 L214 272 C206 278 194 278 186 272 Z" fill="${FON.skinShade}" ${O2}/>
    <path d="M106 160 C106 98 148 70 200 70 C252 70 294 98 294 160 C294 212 254 258 200 260 C146 258 106 212 106 160 Z" fill="url(#skin-${id})" ${O}/>
    <path d="M120 206 C140 236 170 250 200 251 C230 250 260 236 280 206" fill="none" stroke="${FON.skinShade}" stroke-width="5" opacity=".55" stroke-linecap="round"/>
  </g>`;
}

// ------------------------------------------------------------------ face
function eyeOpen(cx, cy, id, flip = 1) {
  return `<g transform="translate(${cx} ${cy}) scale(${flip} 1)">
    <ellipse rx="25" ry="31" fill="#fff"/>
    <ellipse cy="3" rx="22" ry="28" fill="url(#iris-${id})"/>
    <ellipse cy="3" rx="11" ry="15" fill="${FON.irisDeep}"/>
    <ellipse cx="-8" cy="-9" rx="8" ry="9.5" fill="#fff"/>
    <circle cx="9" cy="15" r="4" fill="#fff" opacity=".9"/>
    <path d="M-10 24 Q0 28 10 24" fill="none" stroke="#9FD0FF" stroke-width="3" stroke-linecap="round" opacity=".8"/>
    <path d="M-27 -8 C-20 -30 12 -36 27 -16" fill="none" stroke="${FON.navy}" stroke-width="7" stroke-linecap="round"/>
    <path d="M-27 -8 L-35 -13" stroke="${FON.navy}" stroke-width="5" stroke-linecap="round"/>
    <path d="M-8 34 Q0 36 8 34" fill="none" stroke="${FON.navy}" stroke-width="2" stroke-linecap="round" opacity=".5"/>
  </g>`;
}

function eyeWide(cx, cy, id, flip = 1) {
  return `<g transform="translate(${cx} ${cy}) scale(${flip} 1)">
    <ellipse rx="26" ry="32" fill="#fff" ${O2}/>
    <ellipse cy="2" rx="13" ry="16" fill="url(#iris-${id})"/>
    <ellipse cy="2" rx="6" ry="8" fill="${FON.irisDeep}"/>
    <circle cx="-5" cy="-5" r="4.5" fill="#fff"/>
    <path d="M-28 -10 C-20 -34 12 -40 28 -18" fill="none" stroke="${FON.navy}" stroke-width="6.5" stroke-linecap="round"/>
  </g>`;
}

/** Half-lidded, concentrating eye (the one without the visor while she scans). */
function eyeFocus(cx, cy, id) {
  return `<g transform="translate(${cx} ${cy + 6})">
    <path d="M-24 -6 C-14 -10 14 -10 24 -6 C22 14 12 24 0 24 C-12 24 -22 14 -24 -6 Z" fill="#fff"/>
    <ellipse cy="6" rx="15" ry="16" fill="url(#iris-${id})"/>
    <ellipse cy="7" rx="7" ry="9" fill="${FON.irisDeep}"/>
    <circle cx="-5" cy="1" r="4" fill="#fff"/>
    <path d="M-27 -6 C-14 -12 14 -12 27 -6" fill="none" stroke="${FON.navy}" stroke-width="7" stroke-linecap="round"/>
  </g>`;
}

const eyeHappy = (cx, cy) => `<path d="M${cx - 22} ${cy + 6} Q${cx} ${cy - 22} ${cx + 22} ${cy + 6}" fill="none" stroke="${FON.navy}" stroke-width="7" stroke-linecap="round"/>`;
const eyeSleep = (cx, cy) => `<path d="M${cx - 22} ${cy - 2} Q${cx} ${cy + 18} ${cx + 22} ${cy - 2}" fill="none" stroke="${FON.navy}" stroke-width="6" stroke-linecap="round"/><path d="M${cx - 16} ${cy + 12} l-6 5 M${cx} ${cy + 16} l0 7 M${cx + 16} ${cy + 12} l6 5" stroke="${FON.navy}" stroke-width="2.4" stroke-linecap="round"/>`;
const eyeShout = (cx, cy, dir) => `<path d="M${cx - 20 * dir} ${cy - 16} L${cx + 18 * dir} ${cy} L${cx - 20 * dir} ${cy + 16}" fill="none" stroke="${FON.navy}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
const eyeSwirl = (cx, cy) => `<g transform="translate(${cx} ${cy})"><ellipse rx="24" ry="29" fill="#fff" ${O2}/><path d="M0 0 m-3 0 a3 3 0 1 1 6 0 a7 7 0 1 1 -14 0 a11 11 0 1 1 22 0 a15 15 0 1 1 -30 0" fill="none" stroke="${FON.iris}" stroke-width="3.2" stroke-linecap="round"/></g>`;

function face(id) {
  const L = [158, 176];
  const R = [242, 176];
  const brows = (d) => `<g class="brows">${d}</g>`;
  return `<g>
    <ellipse cx="140" cy="214" rx="17" ry="9" fill="${FON.blush}" opacity=".5"/>
    <ellipse cx="260" cy="214" rx="17" ry="9" fill="${FON.blush}" opacity=".5"/>
    <path d="M198 204 l3 3" stroke="#E7A992" stroke-width="3" stroke-linecap="round"/>
    <g class="eyes eyes-open">${eyeOpen(L[0], L[1], id)}${eyeOpen(R[0], R[1], id)}</g>
    <g class="eyes eyes-wide">${eyeWide(L[0], L[1], id)}${eyeWide(R[0], R[1], id)}</g>
    <g class="eyes eyes-happy">${eyeHappy(L[0], L[1])}${eyeHappy(R[0], R[1])}</g>
    <g class="eyes eyes-sleep">${eyeSleep(L[0], L[1] + 4)}${eyeSleep(R[0], R[1] + 4)}</g>
    <g class="eyes eyes-shout">${eyeShout(L[0], L[1], 1)}${eyeShout(R[0], R[1], -1)}</g>
    <g class="eyes eyes-swirl">${eyeSwirl(L[0], L[1])}${eyeSwirl(R[0], R[1])}</g>
    <g class="eyes eyes-scan">${eyeWide(L[0], L[1], id)}${eyeFocus(R[0], R[1], id)}</g>
    ${brows(`<path class="brow-calm" d="M136 128 Q156 118 176 124 M224 124 Q244 118 264 128" fill="none" stroke="${FON.hairShade}" stroke-width="4.5" stroke-linecap="round"/>
      <path class="brow-worry" d="M138 124 Q156 124 174 114 M226 114 Q244 124 262 124" fill="none" stroke="${FON.hairShade}" stroke-width="4.5" stroke-linecap="round"/>
      <path class="brow-alarm" d="M138 110 L176 126 M262 110 L224 126" fill="none" stroke="${FON.navy}" stroke-width="5" stroke-linecap="round"/>`)}
    <g class="mouth mouth-smile"><path d="M184 226 Q200 244 216 226 Q200 232 184 226 Z" fill="${FON.mouth}" ${O2}/><path d="M192 234 Q200 239 208 234" fill="none" stroke="#FF8FA3" stroke-width="3" stroke-linecap="round"/></g>
    <g class="mouth mouth-grin"><path d="M180 224 Q200 256 220 224 Z" fill="${FON.mouth}" ${O2}/><path d="M188 240 Q200 250 212 240" fill="#FF8FA3"/></g>
    <g class="mouth mouth-o"><ellipse cx="200" cy="232" rx="8" ry="10" fill="${FON.mouth}" ${O2}/></g>
    <g class="mouth mouth-shout"><path d="M176 222 Q200 272 224 222 Q200 230 176 222 Z" fill="${FON.mouth}" ${O2}/><path d="M186 248 Q200 262 214 248" fill="#FF8FA3"/></g>
    <g class="mouth mouth-wavy"><path d="M182 232 q6 -6 12 0 q6 6 12 0 q6 -6 12 0" fill="none" stroke="${FON.navy}" stroke-width="3.2" stroke-linecap="round"/></g>
    <g class="mouth mouth-sleep"><path d="M194 232 Q200 236 206 232" fill="none" stroke="${FON.navy}" stroke-width="3" stroke-linecap="round"/></g>
    <g class="mouth mouth-smirk"><path d="M188 230 Q204 238 214 226" fill="none" stroke="${FON.navy}" stroke-width="3.4" stroke-linecap="round"/></g>
  </g>`;
}

function hairFront(id) {
  // side-swept bangs, parted right of centre, with a strand crossing onto the visor side
  return `<g>
    <path d="M104 168 C96 200 100 236 114 266 C118 244 122 214 126 190 C118 186 110 178 104 168 Z" fill="url(#hairBack-${id})" ${O}/>
    <path d="M296 168 C304 200 300 236 286 266 C282 244 278 214 274 190 C282 186 290 178 296 168 Z" fill="url(#hairBack-${id})" ${O}/>
    <path d="M96 170 C92 100 140 56 202 56 C264 56 310 98 304 170
      C296 156 290 144 284 128 C280 144 272 154 262 160
      C262 144 258 128 250 114 C244 136 232 150 218 158
      C222 140 222 124 218 108 C206 130 190 146 170 154
      C176 140 178 126 176 112 C162 132 146 146 128 154
      C132 140 132 128 128 118 C116 134 106 150 96 170 Z" fill="url(#hair-${id})" ${O}/>
    <path d="M132 100 C156 80 196 72 226 76 C252 80 270 92 282 106 L274 110 L268 101 L261 111 L253 100 L245 110 L236 99 L228 109 L219 98 L210 108 L201 98 L192 108 L183 99 L174 109 L165 100 L156 110 L148 102 L140 112 Z" fill="#fff" opacity=".42"/>
    <path d="M146 150 C150 132 158 118 170 108 M206 150 C208 132 212 118 222 104 M258 150 C256 136 252 124 246 114" fill="none" stroke="${FON.hairShade}" stroke-width="2.6" stroke-linecap="round" opacity=".7"/>
    <path d="M110 214 C108 232 112 246 118 256 M290 214 C292 232 288 246 282 256" fill="none" stroke="${FON.hairShade}" stroke-width="2.4" stroke-linecap="round" opacity=".7"/>
    <g transform="rotate(12 234 52)">
      <path d="M228 66 C229 52 234 40 242 30 C250 40 256 48 257 56 A15 15 0 0 1 229 62" fill="${FON.hairLight}" fill-opacity=".55" stroke="${FON.navy}" stroke-width="8.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M228 66 C229 52 234 40 242 30 C250 40 256 48 257 56 A15 15 0 0 1 229 62" fill="none" stroke="${FON.hair}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  </g>`;
}

function visor(id) {
  // rain scouter over her right eye = the picture's left
  return `<g class="visor">
    <path d="M124 150 C142 140 178 140 196 152 C200 168 198 190 190 204 C174 212 142 212 126 204 C118 188 118 166 124 150 Z" fill="url(#lens-${id})" stroke="#fff" stroke-width="4"/>
    <path d="M124 150 C142 140 178 140 196 152 C200 168 198 190 190 204 C174 212 142 212 126 204 C118 188 118 166 124 150 Z" fill="none" ${O2}/>
    <path d="M132 156 L150 154" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".8"/>
    <rect x="98" y="140" width="28" height="74" rx="12" fill="${FON.coat}" ${O2}/>
    <rect class="visor-light" x="106" y="152" width="10" height="46" rx="5" fill="${FON.cyan}" stroke="${FON.navy}" stroke-width="1.6"/>
    <path d="M112 140 L112 124" fill="none" ${O2}/>
    <circle cx="112" cy="119" r="6" fill="${FON.cyan}" stroke="${FON.navy}" stroke-width="2.2"/>
  </g>`;
}

// ------------------------------------------------------------------ extras
function extras() {
  const warn = '#F5A524';
  const stop = '#FF4D6D';
  return `<g class="fx fx-watch"><g transform="translate(326 94) rotate(8)"><rect x="-17" y="-24" width="34" height="48" rx="12" fill="${warn}" ${O}/><path d="M0 -12 L0 6" stroke="${FON.ink}" stroke-width="6" stroke-linecap="round"/><circle cy="15" r="3.6" fill="${FON.ink}"/></g></g>
    <g class="fx fx-alarm">
      <path d="M72 116 L50 102 M66 150 L40 150 M74 184 L52 198 M328 116 L350 102 M334 150 L360 150 M326 184 L348 198" stroke="${stop}" stroke-width="6" stroke-linecap="round"/>
      <g transform="translate(90 60) rotate(-12)"><rect x="-13" y="-22" width="26" height="44" rx="10" fill="${stop}" ${O}/><path d="M0 -11 L0 5" stroke="#fff" stroke-width="5.5" stroke-linecap="round"/><circle cy="13" r="3.2" fill="#fff"/></g>
    </g>
    <g class="fx fx-confused">
      <g transform="translate(330 90) rotate(10)"><circle r="22" fill="#fff" ${O}/><path d="M-7 -6 A8 8 0 1 1 3 2 L1 8" fill="none" stroke="${FON.ink}" stroke-width="4.5" stroke-linecap="round"/><circle cx="1" cy="15" r="3" fill="${FON.ink}"/></g>
      <path d="M296 112 C302 122 305 128 305 132 A8 8 0 0 1 289 132 C289 128 292 122 296 112 Z" fill="#BFE6FF" ${O2}/>
    </g>
    <g class="fx fx-sleep" fill="${FON.navy}" font-family="Mitr, 'Noto Sans Thai Looped', sans-serif" font-weight="600">
      <text x="300" y="104" font-size="30">z</text><text x="326" y="76" font-size="38">z</text><text x="354" y="42" font-size="46">z</text>
    </g>
    <g class="fx fx-relief" fill="#FFD66B" stroke="${FON.navy}" stroke-width="2.2" stroke-linejoin="round">
      <path d="M72 96 l6 14 14 6 -14 6 -6 14 -6 -14 -14 -6 14 -6 Z"/><path d="M332 70 l5 11 11 5 -11 5 -5 11 -5 -11 -11 -5 11 -5 Z"/><path d="M346 176 l4 8 8 4 -8 4 -4 8 -4 -8 -8 -4 8 -4 Z"/>
    </g>
    <g class="fx fx-scan" fill="none" stroke="${FON.cyan}" stroke-linecap="round">
      <path d="M80 138 A76 76 0 0 1 80 222" stroke-width="5"/><path d="M60 122 A100 100 0 0 1 60 238" stroke-width="4" opacity=".7"/><path d="M40 108 A124 124 0 0 1 40 252" stroke-width="3" opacity=".45"/>
    </g>`;
}

function orb(id) {
  // droplet orb: status light + the sister of น้องเก้า's chat orb
  return `<g class="orb">
    <circle cx="0" cy="0" r="52" fill="url(#glow-${id})"/>
    <circle r="30" fill="url(#orb-${id})" ${O2}/>
    <path d="M-15 4 q7.5 -8 15 0 t15 0" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
    <path d="M-12 -10 C-8 -4 -6 0 -6 3 A6 6 0 0 1 -18 3 C-18 0 -16 -4 -12 -10 Z" fill="#fff" opacity=".85"/>
    <ellipse rx="44" ry="11" transform="rotate(-18)" fill="none" stroke="${FON.navy}" stroke-width="2" opacity=".55"/>
    <ellipse rx="44" ry="11" transform="rotate(-18)" fill="none" class="orb-ring" stroke="${FON.trim}" stroke-width="1.2"/>
    <circle cx="40" cy="-30" r="4" fill="#fff" ${O2}/><circle cx="-30" cy="36" r="3" fill="#fff" ${O2}/>
  </g>`;
}

// ------------------------------------------------------------------ public API
export const MASCOT_CSS = `
.fon .eyes,.fon .mouth,.fon .arms,.fon .fx,.fon .brows path,.fon .orb-at{display:none}
.fon[data-mood=happy] .eyes-open,.fon[data-mood=happy] .mouth-smile,.fon[data-mood=happy] .arms-wave,.fon[data-mood=happy] .brow-calm,.fon[data-mood=happy] .orb-at-happy{display:inline}
.fon[data-mood=relief] .eyes-happy,.fon[data-mood=relief] .mouth-grin,.fon[data-mood=relief] .arms-wave,.fon[data-mood=relief] .brow-calm,.fon[data-mood=relief] .fx-relief,.fon[data-mood=relief] .orb-at-relief{display:inline}
.fon[data-mood=watch] .eyes-wide,.fon[data-mood=watch] .mouth-o,.fon[data-mood=watch] .arms-visor,.fon[data-mood=watch] .brow-worry,.fon[data-mood=watch] .fx-watch,.fon[data-mood=watch] .orb-at-watch{display:inline}
.fon[data-mood=scan] .eyes-scan,.fon[data-mood=scan] .mouth-smirk,.fon[data-mood=scan] .arms-visor,.fon[data-mood=scan] .brow-calm,.fon[data-mood=scan] .fx-scan,.fon[data-mood=scan] .orb-at-scan{display:inline}
.fon[data-mood=alarm] .eyes-shout,.fon[data-mood=alarm] .mouth-shout,.fon[data-mood=alarm] .arms-up,.fon[data-mood=alarm] .brow-alarm,.fon[data-mood=alarm] .fx-alarm,.fon[data-mood=alarm] .orb-at-alarm{display:inline}
.fon[data-mood=confused] .eyes-swirl,.fon[data-mood=confused] .mouth-wavy,.fon[data-mood=confused] .arms-down,.fon[data-mood=confused] .brow-worry,.fon[data-mood=confused] .fx-confused{display:inline}
.fon[data-mood=sleep] .eyes-sleep,.fon[data-mood=sleep] .mouth-sleep,.fon[data-mood=sleep] .arms-down,.fon[data-mood=sleep] .brow-calm,.fon[data-mood=sleep] .fx-sleep{display:inline}
.fon[data-mood=watch] .orb-mid,.fon[data-mood=watch] .glow-in,.fon[data-mood=watch] .glow-out{stop-color:#F5A524}
.fon[data-mood=watch] .orb-edge{stop-color:#D9871A}
.fon[data-mood=alarm] .orb-mid,.fon[data-mood=alarm] .glow-in,.fon[data-mood=alarm] .glow-out{stop-color:#FF4D6D}
.fon[data-mood=alarm] .orb-edge{stop-color:#D12C50}
.fon[data-mood=scan] .orb-mid,.fon[data-mood=scan] .glow-in,.fon[data-mood=scan] .glow-out{stop-color:#82EBFD}
.fon.fon-face .arms,.fon.fon-face .fx{display:none}
`;

const ORB_AT = { happy: [100, 312], relief: [100, 312], watch: [328, 300], scan: [328, 300], alarm: [338, 282] };

/**
 * Full-body น้องฝน. mood is only the starting mood: change it later with
 * el.setAttribute('data-mood', …) on the returned <svg class="fon">.
 */
export function mascotSvg({ mood = 'happy', size = 220, idSuffix = 'm', title = 'น้องฝน' } = {}) {
  const id = idSuffix;
  const pose = arms(id);
  const orbs = Object.entries(ORB_AT).map(([m, [x, y]]) => `<g class="orb-at orb-at-${m}" transform="translate(${x} ${y})">${orb(id)}</g>`).join('');
  return `<svg class="fon" data-mood="${MOODS.includes(mood) ? mood : 'happy'}" viewBox="20 0 360 520" width="${size}" height="${Math.round(size * 520 / 360)}" role="img" aria-label="${title}" xmlns="http://www.w3.org/2000/svg">
    <style>${MASCOT_CSS}</style>
    ${defs(id)}
    <ellipse cx="200" cy="506" rx="96" ry="11" fill="${FON.navy}" opacity=".14"/>
    ${hairBack(id)}${hood()}${legs()}${boots()}${skirt()}${torso(id)}${pose.back}${head(id)}${face(id)}${hairFront(id)}${visor(id)}${pose.front}${extras()}
    <g class="orbs">${orbs}</g>
  </svg>`;
}

/** Head-and-shoulders crop for avatars, the favicon-sized brand mark and alert pictures. */
export function faceSvg({ size = 48, idSuffix = 'f', mood = 'happy' } = {}) {
  return mascotSvg({ mood, size, idSuffix })
    .replace('class="fon"', 'class="fon fon-face"')
    .replace(/viewBox="[^"]*"/, 'viewBox="80 8 240 240"')
    .replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)
    .replace('<g class="orbs">', '<g class="orbs" display="none">');
}

/** Which mood fits a reading. */
export function moodFor(status, { paused = false, pending = false, checking = false, recovered = false } = {}) {
  if (paused) return 'sleep';
  if (pending || checking) return 'scan';
  if (status === 'critical') return 'alarm';
  if (status === 'warning') return 'watch';
  if (status === 'unknown') return 'confused';
  if (recovered) return 'relief';
  return 'happy';
}
