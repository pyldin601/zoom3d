// requestAnimationFrame loop delivering dt in seconds. Returns a stop function.
export function startLoop(tick: (dt: number) => void): () => void {
  let last: number | null = null;
  let id = 0;
  const frame = (now: number) => {
    const dt = last === null ? 0 : (now - last) / 1000;
    last = now;
    tick(dt);
    id = requestAnimationFrame(frame);
  };
  id = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(id);
}
