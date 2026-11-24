export function vehicleLink(raw: string) {
  const value = raw.trim();
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  const absolute = /^https?:\/\//i.test(value);
  if (!absolute && !/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(value)) return null;
  const href = absolute ? value : `https://${value}`;
  try {
    const url = new URL(href);
    if (!url.hostname || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const matches = (domain: string) => host === domain || host.endsWith('.' + domain);
    if (matches('avito.ru')) return { href, label: 'Авито', hint: 'Открыть объявление' };
    if (matches('autoteka.ru')) return { href, label: 'Автотека', hint: 'Открыть отчёт' };
    return { href, label: 'Ссылка', hint: host };
  } catch { return null; }
}
