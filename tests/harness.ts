// In-browser test harness for the dev server. Load the game with `?debug`, then in the console:
//   await import('/tests/harness.ts');  await T.solo();  await T.hold('KeyE', 2);  T.where()
// Uses the deterministic `fog.step()` so tests work even when the tab is not being composited.
/* eslint-disable @typescript-eslint/no-explicit-any */
const fog = () => (window as any).fog;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const btn = (txt: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('#ui button')].find((b) => b.textContent!.trim().startsWith(txt) && b.offsetParent);

const T = {
  /** advance the simulation by `sec` seconds, flushing microtasks (LocalNet actions) every 0.1 s */
  async run(sec: number) {
    const n = Math.round(sec * 60);
    for (let i = 0; i < n; i += 6) {
      fog().step(Math.min(6, n - i));
      await Promise.resolve();
      await sleep(0);
    }
  },
  key(code: string, down: boolean) {
    dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
  },
  async hold(code: string, sec: number) {
    T.key(code, true);
    await T.run(sec);
    T.key(code, false);
    await T.run(0.2);
  },
  /** click Solo, then Start; resolves once the local player exists */
  async solo() {
    for (let i = 0; i < 200 && (!btn('单人') || btn('单人')!.disabled); i++) await sleep(250);
    btn('单人')!.click();
    for (let i = 0; i < 100 && !fog()?.step; i++) await sleep(100);
    for (let i = 0; i < 50 && !btn('熄灯'); i++) await T.run(0.1);
    btn('熄灯')!.click();
    for (let i = 0; i < 50 && !fog().player(); i++) await T.run(0.1);
    return !!fog().player();
  },
  where() {
    const p = fog().player();
    const w = fog().ctx.world();
    return {
      pos: p.position.toArray().map((v: number) => +v.toFixed(2)),
      ry: +p.ry.toFixed(2), mode: p.mode, zone: p.zone, chapter: w.chapter, phase: w.phase,
      flags: w.flags, alarm: w.alarm, status: w.players[fog().ctx.myId]?.s,
      best: fog().interaction.best.valid ? fog().interaction.best.id : null,
    };
  },
  teleport(x: number, y: number, z: number, ry?: number) { fog().player().teleport([x, y, z], ry); },
  /** walk toward a point (x, z) with W, steering the camera rig */
  async walkTo(x: number, z: number, maxSec = 20, run = false) {
    const p = fog().player();
    const rig = fog().rig;
    if (run) T.key('ShiftLeft', true);
    T.key('KeyW', true);
    for (let t = 0; t < maxSec; t += 0.1) {
      const dx = x - p.position.x, dz = z - p.position.z;
      if (Math.hypot(dx, dz) < 0.35) break;
      rig.yaw = Math.atan2(-dx, -dz);
      await T.run(0.1);
    }
    T.key('KeyW', false);
    if (run) T.key('ShiftLeft', false);
    await T.run(0.2);
    return T.where();
  },
};
(window as any).T = T;
export default T;
