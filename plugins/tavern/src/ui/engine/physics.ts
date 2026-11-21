export type Body = {
  x: number; vx: number; ax: number;
  lift: number; vy: number;
  swing: number; angularVelocity: number;
};

export const WALK_SPEED = 36;

export function createBody(): Body {
  return { x: 0, vx: 0, ax: 0, lift: 0, vy: 0, swing: 0, angularVelocity: 0 };
}

export function hop(body: Body) {
  if (body.lift === 0) body.vy = 120;
}

export function settled(body: Body) {
  return body.vx === 0 && body.vy === 0 && body.lift === 0 && body.swing === 0 && body.angularVelocity === 0;
}

export function stepBody(body: Body, target: number | null, dt: number) {
  const previous = body.vx;
  if (target === null) {
    body.vx = 0;
  } else {
    const dx = target - body.x;
    const desired = Math.sign(dx) * Math.min(WALK_SPEED, Math.abs(dx) * 10);
    body.vx += (desired - body.vx) * Math.min(1, 8 * dt);
    const move = body.vx * dt;
    if (Math.abs(dx) <= 0.15 || (Math.sign(move) === Math.sign(dx) && Math.abs(move) >= Math.abs(dx))) {
      body.x = target;
      body.vx = 0;
    } else {
      body.x += move;
    }
  }
  body.ax = (body.vx - previous) / dt;
  if (body.lift > 0 || body.vy > 0) {
    body.vy -= 720 * dt;
    body.lift = Math.max(0, body.lift + body.vy * dt);
    if (body.lift === 0) body.vy = 0;
  }
  body.angularVelocity += (-36 * body.swing - 5 * body.angularVelocity - body.ax * 0.06) * dt;
  body.swing += body.angularVelocity * dt;
  if (Math.abs(body.swing) + Math.abs(body.angularVelocity) < 0.0001) {
    body.swing = 0;
    body.angularVelocity = 0;
  }
}
