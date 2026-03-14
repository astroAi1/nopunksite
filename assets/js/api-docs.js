(() => {
  'use strict';

  const productionOrigin = 'https://nopunks.xyz';
  const runtimeOrigin = String(window.location.origin || productionOrigin).replace(/\/+$/, '');
  const isLocalPreview = /^(localhost|127\.0\.0\.1)$/i.test(String(window.location.hostname || '').trim());
  const displayOrigin = isLocalPreview ? productionOrigin : runtimeOrigin;

  document.querySelectorAll('[data-origin-slot]').forEach((el) => {
    el.textContent = displayOrigin;
  });

  document.querySelectorAll('[data-origin-template]').forEach((el) => {
    const template = el.getAttribute('data-origin-template') || '';
    el.textContent = template.replace(/__ORIGIN__/g, displayOrigin);
  });

  document.querySelectorAll('[data-origin-href]').forEach((el) => {
    const template = el.getAttribute('data-origin-href') || '';
    el.setAttribute('href', template.replace(/__ORIGIN__/g, runtimeOrigin));
  });

  document.querySelectorAll('[data-origin-src]').forEach((el) => {
    const template = el.getAttribute('data-origin-src') || '';
    el.setAttribute('src', template.replace(/__ORIGIN__/g, runtimeOrigin));
  });

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  document.querySelectorAll('[data-copy-target]').forEach((button) => {
    button.addEventListener('click', async () => {
      const targetId = button.getAttribute('data-copy-target');
      const target = targetId ? document.getElementById(targetId) : null;
      if (!target) return;

      const originalText = button.textContent;
      try {
        await copyText(target.textContent || '');
        button.textContent = 'Copied';
      } catch (err) {
        console.error('Copy failed', err);
        button.textContent = 'Failed';
      }

      window.setTimeout(() => {
        button.textContent = originalText;
      }, 1200);
    });
  });
})();
