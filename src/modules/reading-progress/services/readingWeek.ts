/** Calendar weeks follow the reader's local dates, from Monday through Sunday. */
export function summarizeReadingWeek(store: Record<string, number>, now = new Date()) {
  const elapsedDays = (now.getDay() + 6) % 7 + 1;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - elapsedDays + 1);
  const dateKey = (offset: number) => {
    const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + offset);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  };
  const sumDays = (offset: number, count: number) => {
    let seconds = 0;
    for (let day = offset; day < offset + count; day += 1) {
      const value = store[dateKey(day)] ?? 0;
      if (Number.isFinite(value) && value > 0) seconds += Math.round(value);
    }
    return seconds;
  };
  return {
    startDateKey: dateKey(0),
    endDateKey: dateKey(6),
    seconds: sumDays(0, elapsedDays),
    previousSeconds: sumDays(-7, 7),
    previousToDateSeconds: sumDays(-7, elapsedDays),
  };
}
