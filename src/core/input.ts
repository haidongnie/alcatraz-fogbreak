/**
 * Keyboard + mouse (pointer lock) + first gamepad + virtual touch controls. Uses `e.code` so WASD
 * works on any layout. Read movement in fixed updates, look deltas in the per-frame update, then
 * call `endFrame()`.
 *
 * Touch UI (src/ui/touch.ts) feeds the same state through `setVirtualAxis`, `setVirtualButton`
 * and `addLook`, so game code never needs to know which device is in use. Virtual buttons use the
 * keyboard codes they stand for ('KeyE', 'KeyC', 'ShiftLeft', 'KeyG', 'Space', ...).
 */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();
  private readonly virtualDown = new Set<string>();
  private readonly virtualAxis = { x: 0, y: 0 };
  /** Accumulated look movement (pixels) since the last `endFrame()`. */
  readonly look = { x: 0, y: 0 };
  /** Mouse wheel delta since the last `endFrame()` (camera zoom). */
  wheel = 0;
  gamepad: Gamepad | null = null;
  /** When false (menus open), pointer lock is not requested on click. */
  pointerLockAllowed = true;
  private readonly abort = new AbortController();

  constructor(private readonly canvas: HTMLCanvasElement) {
    const { signal } = this.abort;
    addEventListener('keydown', (e) => {
      if (e.repeat || isTyping(e)) return;
      if (e.code === 'Tab') e.preventDefault();
      this.down.add(e.code);
      this.pressed.add(e.code);
    }, { signal });
    addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.released.add(e.code);
    }, { signal });
    addEventListener('blur', () => this.down.clear(), { signal });
    canvas.addEventListener('click', () => {
      if (this.pointerLockAllowed && !matchMedia('(pointer: coarse)').matches) void canvas.requestPointerLock?.();
    }, { signal });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.look.x += e.movementX;
      this.look.y += e.movementY;
    }, { signal });
    canvas.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { signal, passive: true });
  }

  get locked() { return document.pointerLockElement === this.canvas; }
  /** true when look input should be applied (pointer locked, or touch look active) */
  get lookActive() { return this.locked || this.touchLook; }
  private touchLook = false;

  isDown(code: string) { return this.down.has(code) || this.virtualDown.has(code); }
  /** True only during the frame the key went down. */
  wasPressed(code: string) { return this.pressed.has(code); }
  /** True only during the frame the key went up. */
  wasReleased(code: string) { return this.released.has(code); }
  /** -1..1 from two keys, e.g. axis('KeyA', 'KeyD'); falls back to the virtual stick and gamepad. */
  axis(negative: string, positive: string) {
    let v = (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
    if (v === 0) {
      if (negative === 'KeyA') v = this.virtualAxis.x;
      if (negative === 'KeyS') v = this.virtualAxis.y;
    }
    if (this.gamepad && v === 0) {
      const gp = this.gamepad.axes;
      if (negative === 'KeyA') v = Math.abs(gp[0]) > 0.15 ? gp[0] : 0;
      if (negative === 'KeyS') v = Math.abs(gp[1]) > 0.15 ? -gp[1] : 0;
    }
    return v;
  }

  // --- virtual (touch) controls -------------------------------------------------------------
  /** x: strafe -1..1 (right +), y: forward -1..1 (forward +) */
  setVirtualAxis(x: number, y: number) { this.virtualAxis.x = x; this.virtualAxis.y = y; }
  setVirtualButton(code: string, isDown: boolean) {
    if (isDown && !this.virtualDown.has(code)) this.pressed.add(code);
    if (!isDown && this.virtualDown.has(code)) this.released.add(code);
    if (isDown) this.virtualDown.add(code); else this.virtualDown.delete(code);
  }
  addLook(dx: number, dy: number) { this.touchLook = true; this.look.x += dx; this.look.y += dy; }

  exitPointerLock() { if (this.locked) document.exitPointerLock(); }

  poll() {
    this.gamepad = navigator.getGamepads?.()[0] ?? null;
    if (this.gamepad) {
      const b = this.gamepad.buttons;
      // A = interact, B = crouch, X = drop, LB = run
      const map: [number, string][] = [[0, 'KeyE'], [1, 'KeyC'], [2, 'KeyG'], [4, 'ShiftLeft'], [3, 'Space']];
      for (const [i, code] of map) this.setVirtualButton(code, !!b[i]?.pressed);
      const ax = this.gamepad.axes;
      if (Math.abs(ax[2] ?? 0) > 0.15 || Math.abs(ax[3] ?? 0) > 0.15) {
        this.touchLook = true;
        this.look.x += (ax[2] ?? 0) * 14;
        this.look.y += (ax[3] ?? 0) * 10;
      }
    }
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.look.x = 0;
    this.look.y = 0;
    this.wheel = 0;
  }

  dispose() { this.abort.abort(); }
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
