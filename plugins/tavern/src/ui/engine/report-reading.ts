export const REPORT_READING = "[data-tavern-report-at], [data-tavern-report], .evidence-list";
const clips = (overflow: string) => /^(auto|scroll|hidden|clip|overlay)$/.test(overflow);

function inView(el: Element) {
  const box = el.getBoundingClientRect();
  let top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
  let left = Math.max(0, box.left), right = Math.min(innerWidth, box.right);
  if (top >= bottom || left >= right || getComputedStyle(el).visibility === "hidden") return false;
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const clipX = clips(style.overflowX), clipY = clips(style.overflowY);
    if (!clipX && !clipY) continue;
    const rect = parent.getBoundingClientRect();
    if (clipX) { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
    if (clipY) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
    if (top >= bottom || left >= right) return false;
  }
  return true;
}

export function reportReading(threadId: string) {
  let reportInView = false;
  let latestReportAt = -Infinity;
  for (const el of document.querySelectorAll(REPORT_READING)) {
    const stamp = el.getAttribute("data-tavern-report-at");
    if (stamp !== null && Number.isFinite(Number(stamp)) && el.closest("[data-tavern-report-thread]")?.getAttribute("data-tavern-report-thread") === threadId)
      latestReportAt = Math.max(latestReportAt, Number(stamp));
    if (!reportInView) reportInView = inView(el);
  }
  return { reportInView, latestReportAt };
}
