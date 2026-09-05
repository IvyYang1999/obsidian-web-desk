/**
 * 拖着对象碰到视口边缘时，画布朝那个方向自己滚起来。
 *
 * 这是「可扩张的房间」在操作上的另一半：墙会跟着内容长，但如果拖到视口边缘就卡住，
 * 用户还是得松手、平移、再拖。有了边缘平移，感觉是「我拖着它走，空间自己让开」。
 */

export interface EdgePanRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 边缘感应带宽度（屏幕像素）。 */
export const EDGE_BAND = 64;
/** 贴到最边上时每秒平移多少屏幕像素。 */
export const EDGE_MAX_SPEED = 1100;

function axisVelocity(position: number, start: number, size: number, band: number, maxSpeed: number): number {
  const fromStart = position - start;
  const fromEnd = start + size - position;
  // 指针跑到容器外就按满速，不然快速甩动时会忽快忽慢。
  if (fromStart < band) {
    const intensity = Math.min(1, Math.max(0, (band - fromStart) / band));
    return maxSpeed * intensity * intensity;
  }
  if (fromEnd < band) {
    const intensity = Math.min(1, Math.max(0, (band - fromEnd) / band));
    return -maxSpeed * intensity * intensity;
  }
  return 0;
}

/**
 * 指针位置 → 画布平移速度（屏幕像素/秒）。
 * 返回的是 pan 的增量方向：指针贴右边缘时为负，因为要把内容往左推才能看到右边。
 * 越深入边缘带越快（二次曲线），带外为 0。
 */
export function edgePanVelocity(
  client: { x: number; y: number },
  rect: EdgePanRect,
  band = EDGE_BAND,
  maxSpeed = EDGE_MAX_SPEED,
): { x: number; y: number } {
  if (rect.width <= band * 2 || rect.height <= band * 2) return { x: 0, y: 0 };
  return {
    x: axisVelocity(client.x, rect.left, rect.width, band, maxSpeed),
    y: axisVelocity(client.y, rect.top, rect.height, band, maxSpeed),
  };
}

export interface CanvasEdgePanOptions {
  rect: () => EdgePanRect;
  /** 每帧把画布平移这么多屏幕像素；调用方负责让对象继续跟手并让墙长出来。 */
  step: (dx: number, dy: number) => void;
}

/** 拖拽期间的边缘平移循环；指针离开边缘带就自动停下，不需要调用方判断。 */
export class CanvasEdgePan {
  private frame: number | null = null;
  private pointer: { x: number; y: number } | null = null;
  private lastAt = 0;

  constructor(private readonly options: CanvasEdgePanOptions) {}

  update(client: { x: number; y: number }): void {
    this.pointer = client;
    if (this.frame !== null) return;
    this.lastAt = performance.now();
    this.frame = window.requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.pointer = null;
  }

  private readonly tick = (now: number): void => {
    const pointer = this.pointer;
    if (!pointer) { this.frame = null; return; }
    // 掉帧时不要一次跳很远，上限相当于 20fps 的一帧。
    const seconds = Math.min(0.05, Math.max(0, (now - this.lastAt) / 1000));
    this.lastAt = now;
    const velocity = edgePanVelocity(pointer, this.options.rect());
    if (velocity.x !== 0 || velocity.y !== 0) {
      this.options.step(velocity.x * seconds, velocity.y * seconds);
    }
    this.frame = window.requestAnimationFrame(this.tick);
  };
}
