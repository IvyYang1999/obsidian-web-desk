export interface EmbedInstanceHandoff {
  zoom: number;
  panX: number;
  panY: number;
  fullscreen: boolean;
  focused: boolean;
  pointerFocused: boolean;
  selectedObjects?: string[];
  selectedGroupId?: string | null;
  selectedArrowId?: string | null;
  expiresAt: number;
}

interface EmbedInstanceState {
  activeInstanceId: number;
  queue: Promise<void>;
  handoff?: EmbedInstanceHandoff;
  supersede?: () => EmbedInstanceHandoff | void;
}

export interface EmbedInstanceRegistration {
  instanceId: number;
  handoff?: EmbedInstanceHandoff;
}

export type EmbedWriteResult = "written" | "stale";

const states = new Map<string, EmbedInstanceState>();
let nextInstanceId = 0;

function stateFor(key: string): EmbedInstanceState {
  let state = states.get(key);
  if (!state) {
    state = { activeInstanceId: 0, queue: Promise.resolve() };
    states.set(key, state);
  }
  return state;
}

/** 同一 workspace leaf 的同一代码块只允许最新渲染实例成为写者。 */
export function registerEmbedInstance(
  key: string,
  onSuperseded?: () => EmbedInstanceHandoff | void,
): EmbedInstanceRegistration {
  const state = stateFor(key);
  const liveHandoff = state.supersede?.();
  if (liveHandoff) state.handoff = liveHandoff;
  const instanceId = ++nextInstanceId;
  state.activeInstanceId = instanceId;
  state.supersede = onSuperseded;
  const handoff = state.handoff && state.handoff.expiresAt >= Date.now()
    ? state.handoff
    : undefined;
  state.handoff = undefined;
  return { instanceId, handoff };
}

/** 仅当前实例能发布一次性视图状态，供写回触发的新实例接管。 */
export function publishEmbedHandoff(
  key: string,
  instanceId: number,
  handoff: EmbedInstanceHandoff,
): boolean {
  const state = stateFor(key);
  if (state.activeInstanceId !== instanceId) return false;
  state.handoff = handoff;
  return true;
}

/** 队列跨实例共享；任务真正执行前再次检查写者身份，旧实例 fail closed。 */
export function enqueueEmbedWrite(
  key: string,
  instanceId: number,
  write: () => Promise<void>,
): Promise<EmbedWriteResult> {
  const state = stateFor(key);
  const run = state.queue.then(async (): Promise<EmbedWriteResult> => {
    if (state.activeInstanceId !== instanceId) return "stale";
    await write();
    return "written";
  });
  state.queue = run.then(() => undefined, () => undefined);
  return run;
}
