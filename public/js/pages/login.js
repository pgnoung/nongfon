import { $, initChrome, mountMascot } from '../app.js';

initChrome();
const holder = $('[data-login-mascot]');
const mascot = holder ? mountMascot(holder, { mood: 'happy', size: 170, idSuffix: 'login' }) : null;
if (document.body.dataset.demo === 'true') $('[data-demo-hint]')?.removeAttribute('hidden');

const form = $('[data-login]');
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('[data-login-error]');
  error.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: form.password.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'เข้าสู่ระบบไม่สำเร็จ');
    const next = new URLSearchParams(location.search).get('next');
    location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  } catch (err) {
    error.textContent = err.message;
    form.password.select();
    mascot?.setMood('confused');
  } finally {
    button.disabled = false;
  }
});
