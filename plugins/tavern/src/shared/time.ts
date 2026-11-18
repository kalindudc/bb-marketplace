export function clockTime(at: number) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export function moveTime(at: number, now: number) {
  const d = new Date(at), today = new Date(now);
  const day = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const distance = Math.abs(day(today) - day(d)) / 86_400_000;
  if (distance === 0) return clockTime(at);
  const date = distance < 7 ? d.toLocaleDateString("en", { weekday: "short" }) : `${d.getDate()} ${d.toLocaleDateString("en", { month: "short" })}`;
  return `${date} ${clockTime(at)}`;
}
