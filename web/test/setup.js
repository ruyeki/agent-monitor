// jsdom has no EventSource; tests that need it mock it themselves.
// React Flow needs ResizeObserver and DOMMatrixReadOnly.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.DOMMatrixReadOnly ??= class {
  constructor() {
    this.m22 = 1;
  }
};
