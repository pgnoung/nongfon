# น้องฝนเฝ้าบ้าน (NongFon) — instructions for AI coding agents

This repository is NongFon: a local-first CCTV + AI flood watcher that runs on the owner's own computer.

- To install, set up, check, fix or extend it, follow the skill at `.agents/skills/nongfon-setup/SKILL.md`
  (the same file is at `.claude/skills/nongfon-setup/SKILL.md` for Claude Code). The student prompt is `00_START_HERE_PROMPT.md`.
- Talk to the user in Thai, politely, one question at a time.
- Never ask for API keys, tokens, passwords or camera passwords in chat. The owner types them into
  `bash install/nongfon.sh secrets` (Windows: NongFon-windows.bat → menu 3) in their own terminal, or into the NongFon dashboard. Set non-secret values with `node scripts/set-env.js KEY=value`.
- Never print or open `.env`; use `npm run doctor` (it masks secrets). `npm run doctor -- --json` is for agents.
- Keep it local: never expose the dashboard port to the internet. Remote access = Tailscale or Cloudflare Tunnel + Access.
- Do not sign up, buy, pay or accept terms for the user.
- After any code change run `npm test`; keep the alarm safety rules (red line wins, re-check before waking,
  say "cannot see" instead of guessing).
