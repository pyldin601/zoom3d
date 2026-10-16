// requestAnimationFrame loop delivering dt in seconds. Returns a stop function.
export function startLoop(tick: (dt: number) => void): () => void {
  let last: number | null = null;
  let id = 0;
  const frame = (now: number) => {
    const dt = last === null ? 0 : (now - last) / 1000;
    last = now;
    // Scheduled before the tick: one that throws can't freeze the view for good, and one can stop the loop.
    id = requestAnimationFrame(frame);
    tick(dt);
  };
  id = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(id);
}
