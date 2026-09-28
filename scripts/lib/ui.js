// Terminal questions for the setup wizard. Every question has an id so a test (or a scripted run)
// can answer it without a keyboard. Secrets are read with echo off — never shown on screen.

import readline from 'node:readline/promises';

const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Read one line with echo off (raw mode). Handles paste, backspace, Ctrl-U and Ctrl-C. */
export function readHidden(prompt, { input = process.stdin, output = process.stdout, onAbort = () => process.exit(130) } = {}) {
  return new Promise((resolve) => {
    output.write(`${prompt} `);
    const wasRaw = Boolean(input.isRaw);
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    let value = '';
    const finish = (abort) => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write(value ? ' (รับแล้ว ซ่อนไว้)\n' : '\n');
      if (abort) onAbort();
      else resolve(value.trim());
    };
    function onData(chunk) {
      for (const ch of String(chunk).replace(ANSI_SEQUENCE, '')) {
        if (ch === '\r' || ch === '\n') return finish(false);
        if (ch === '\u0003') return finish(true); // Ctrl-C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch === '\u0015') value = ''; // Ctrl-U
        else if (ch >= ' ') value += ch;
      }
      return undefined;
    }
    input.on('data', onData);
  });
}

function normalizeOptions(options) {
  return options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
}

/** Questions on a real keyboard + screen. */
export function createTerminalIO({ input = process.stdin, output = process.stdout } = {}) {
  const say = (text = '') => output.write(`${text}\n`);

  async function line(prompt) {
    const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
    try {
      return (await rl.question(prompt)).trim();
    } finally {
      rl.close();
    }
  }

  return {
    interactive: Boolean(input.isTTY),
    say,
    async ask(_id, question, { defaultValue = '' } = {}) {
      const answer = await line(`${question}${defaultValue ? ` [${defaultValue}]` : ''} › `);
      return answer || defaultValue;
    },
    async secret(_id, question) {
      return input.isTTY ? readHidden(`${question} ›`, { input, output }) : line(`${question} › `);
    },
    async confirm(_id, question, { defaultValue = true } = {}) {
      for (;;) {
        const answer = (await line(`${question} ${defaultValue ? '[Y/n]' : '[y/N]'} › `)).toLowerCase();
        if (!answer) return defaultValue;
        if (['y', 'yes', 'ใช่', 'ค่ะ', 'ครับ', 'ok', '1'].includes(answer)) return true;
        if (['n', 'no', 'ไม่', 'ไม่ใช่', '0'].includes(answer)) return false;
        say('  ตอบ y (ใช่) หรือ n (ไม่) ได้เลยค่ะ');
      }
    },
    async choose(_id, question, options, { defaultValue } = {}) {
      const list = normalizeOptions(options);
      say(question);
      list.forEach((o, i) => say(`  ${i + 1}) ${o.label}`));
      const defIndex = Math.max(0, list.findIndex((o) => o.value === defaultValue));
      for (;;) {
        const answer = await line(`  เลือกหมายเลข [${defIndex + 1}] › `);
        if (!answer) return list[defIndex].value;
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1].value;
        say(`  พิมพ์เลข 1–${list.length} ค่ะ`);
      }
    },
  };
}

/**
 * Answers from an object instead of a keyboard ({ id: value } or { id: [first, second, …] } for a
 * question asked more than once). Missing answers take the question's default.
 */
export function createScriptedIO(answers = {}, { log = [] } = {}) {
  const queue = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const take = (id) => (queue[id] && queue[id].length ? queue[id].shift() : undefined);
  return {
    interactive: false,
    log,
    say: (text = '') => log.push(text),
    async ask(id, _q, { defaultValue = '' } = {}) {
      const v = take(id);
      return v === undefined || v === '' ? defaultValue : String(v);
    },
    async secret(id) {
      const v = take(id);
      return v === undefined ? '' : String(v);
    },
    async confirm(id, _q, { defaultValue = true } = {}) {
      const v = take(id);
      return v === undefined ? defaultValue : Boolean(v);
    },
    async choose(id, _q, options, { defaultValue } = {}) {
      const list = normalizeOptions(options);
      const v = take(id);
      if (v !== undefined && list.some((o) => o.value === v)) return v;
      return list.some((o) => o.value === defaultValue) ? defaultValue : list[0].value;
    },
  };
}
