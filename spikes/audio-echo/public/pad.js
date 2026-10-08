// Top-down pad: listener at centre facing up, 1 tile = 20 px. Drag to place the source.
import { REF, MAX, curves } from './audio.js';

const TILE = 20;

export function createPad(canvas, onMove) {
  const g = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  let pos = { dx: Math.SQRT2, dy: -Math.SQRT2 }; // 2 tiles, 45° front-right

  function draw() {
    g.fillStyle = '#000';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.strokeStyle = '#444';
    for (const r of [REF, MAX]) {
      g.beginPath();
      g.arc(cx, cy, r * TILE, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = '#4af';
    g.beginPath();
    g.moveTo(cx, cy - 10);
    g.lineTo(cx - 7, cy + 7);
    g.lineTo(cx + 7, cy + 7);
    g.fill();
    g.fillStyle = '#fa4';
    g.beginPath();
    g.arc(cx + pos.dx * TILE, cy + pos.dy * TILE, 7, 0, Math.PI * 2);
    g.fill();
    const d = Math.hypot(pos.dx, pos.dy);
    const { dry, send } = curves(d);
    g.fillStyle = '#ddd';
    g.font = '13px system-ui';
    g.fillText(`d=${d.toFixed(2)} tiles  dry=${dry.toFixed(3)}  send=${send.toFixed(3)}`, 8, 18);
  }

  function update(e) {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    pos = { dx: (x - cx) / TILE, dy: (y - cy) / TILE };
    draw();
    onMove(pos.dx, pos.dy);
  }

  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); update(e); });
  canvas.addEventListener('pointermove', (e) => { if (e.buttons) update(e); });
  draw();
  return { get: () => pos };
}
