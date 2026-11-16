/** A date as the history cards show it: 2026.11.16 16:42:30 (24 hours, local time, no spaces in the date). */
export function formatDate(value) {
  const d = new Date(value);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
