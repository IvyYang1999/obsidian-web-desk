const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const PORTAL_SELECTOR = [
  ".modal-container",
  ".prompt",
  ".menu",
  ".suggestion-container",
  ".popover",
].join(",");

const boundaryStacks = new WeakMap<Document, CanvasFocusBoundary[]>();

interface InertSnapshot {
  element: HTMLElement;
  inert: boolean;
}

/**
 * A reversible keyboard boundary for canvas overlays.
 *
 * It inerts only sibling branches between the overlay and the requested scope,
 * so an in-canvas drilldown can isolate its canvas without disabling Obsidian's
 * entire workspace, while a body-level preview/fullscreen can be truly modal.
 */
export class CanvasFocusBoundary {
  private readonly document: Document;
  private readonly previousFocus: HTMLElement | null;
  private readonly snapshots: InertSnapshot[] = [];
  private readonly portalObserver: MutationObserver;
  private active = false;
  private activePortal: HTMLElement | null = null;
  private lastFocusInside: HTMLElement | null = null;

  constructor(
    private readonly overlay: HTMLElement,
    private readonly scope: HTMLElement,
    private readonly initialFocus?: HTMLElement,
  ) {
    if (!scope.contains(overlay)) {
      throw new Error("CanvasFocusBoundary scope must contain its overlay");
    }
    this.document = overlay.ownerDocument;
    this.previousFocus = this.document.activeElement instanceof HTMLElement
      ? this.document.activeElement
      : null;
    this.lastFocusInside = this.previousFocus && overlay.contains(this.previousFocus)
      ? this.previousFocus
      : null;
    this.portalObserver = new MutationObserver(() => this.syncPortals());
  }

  activate(): void {
    if (this.active) return;
    this.active = true;
    const stack = boundaryStacks.get(this.document) ?? [];
    stack.push(this);
    boundaryStacks.set(this.document, stack);
    this.isolateSiblingBranches();
    this.document.addEventListener("keydown", this.onKeyDown, true);
    this.document.addEventListener("focusin", this.onFocusIn, true);
    this.portalObserver.observe(this.document.body, { childList: true, subtree: true });
    this.focusFirst();
  }

  release(options: { restoreFocus?: boolean } = {}): void {
    if (!this.active) return;
    this.active = false;
    const stack = boundaryStacks.get(this.document) ?? [];
    const index = stack.lastIndexOf(this);
    if (index >= 0) stack.splice(index, 1);
    if (stack.length === 0) boundaryStacks.delete(this.document);
    this.document.removeEventListener("keydown", this.onKeyDown, true);
    this.document.removeEventListener("focusin", this.onFocusIn, true);
    this.portalObserver.disconnect();
    for (let index = this.snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = this.snapshots[index];
      snapshot.element.inert = snapshot.inert;
    }
    this.snapshots.length = 0;
    this.activePortal = null;
    if (options.restoreFocus !== false && this.previousFocus?.isConnected) {
      this.previousFocus.focus({ preventScroll: true });
    }
  }

  private isolateSiblingBranches(): void {
    let branch: HTMLElement = this.overlay;
    while (branch !== this.scope) {
      const parent = branch.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
        this.snapshots.push({ element: sibling, inert: sibling.inert });
        sibling.inert = true;
      }
      branch = parent;
    }
  }

  private readonly onFocusIn = (event: FocusEvent): void => {
    if (!this.isTopBoundary()) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target && this.overlay.contains(target)) {
      this.lastFocusInside = target;
      return;
    }
    const portal = target?.closest<HTMLElement>(PORTAL_SELECTOR) ?? null;
    if (portal) {
      this.allowPortal(portal);
      this.activePortal = portal;
      return;
    }
    this.focusFirst();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.isTopBoundary() || event.key !== "Tab") return;
    const portal = this.activePortal?.isConnected ? this.activePortal : null;
    const focusScope = portal?.contains(this.document.activeElement)
      ? portal
      : this.overlay;
    const focusable = this.focusableElements(focusScope);
    if (focusable.length === 0) {
      event.preventDefault();
      focusScope.focus({ preventScroll: true });
      return;
    }
    const active = this.document.activeElement;
    const current = focusable.indexOf(active as HTMLElement);
    const next = event.shiftKey
      ? (current <= 0 ? focusable.length - 1 : current - 1)
      : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
    event.preventDefault();
    focusable[next].focus({ preventScroll: true });
  };

  private focusFirst(): void {
    const target = this.initialFocus?.isConnected
      ? this.initialFocus
      : this.focusableElements()[0] ?? this.overlay;
    const requestFrame = this.document.defaultView?.requestAnimationFrame.bind(this.document.defaultView)
      ?? ((callback: FrameRequestCallback) => globalThis.setTimeout(callback, 0));
    requestFrame(() => {
      if (this.active && target.isConnected) target.focus({ preventScroll: true });
    });
  }

  private focusableElements(scope: HTMLElement = this.overlay): HTMLElement[] {
    return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) =>
        element.isConnected &&
        element.getClientRects().length > 0 &&
        !element.inert &&
        !element.closest("[inert]") &&
        element.getAttribute("aria-hidden") !== "true"
      );
  }

  private isTopBoundary(): boolean {
    const stack = boundaryStacks.get(this.document);
    return this.active && stack?.[stack.length - 1] === this;
  }

  private syncPortals(): void {
    if (!this.isTopBoundary()) return;
    const visiblePortals = Array.from(this.document.querySelectorAll<HTMLElement>(PORTAL_SELECTOR))
      .filter((element) => element.isConnected && element.getClientRects().length > 0);
    for (const portal of visiblePortals) this.allowPortal(portal);
    if (this.activePortal?.isConnected && this.activePortal.getClientRects().length > 0) return;
    const hadPortal = Boolean(this.activePortal);
    this.activePortal = null;
    if (!hadPortal) return;
    const target = this.lastFocusInside?.isConnected ? this.lastFocusInside : null;
    const requestFrame = this.document.defaultView?.requestAnimationFrame.bind(this.document.defaultView)
      ?? ((callback: FrameRequestCallback) => globalThis.setTimeout(callback, 0));
    requestFrame(() => {
      if (!this.isTopBoundary()) return;
      (target ?? this.initialFocus ?? this.overlay).focus({ preventScroll: true });
    });
  }

  private allowPortal(portal: HTMLElement): void {
    let branch: HTMLElement | null = portal;
    while (branch && branch !== this.document.body) {
      if (branch.inert) branch.inert = false;
      branch = branch.parentElement;
    }
  }
}
