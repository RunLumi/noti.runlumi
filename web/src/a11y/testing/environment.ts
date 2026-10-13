/**
 * Browser APIs that jsdom lacks and the app (or Base UI) touches. Imported for its side effects
 * by every component test. They are inert stand-ins: they let code run, they do not emulate
 * layout, so nothing here can make a layout-dependent check pass.
 */
type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler = () => Promise.reject(new TypeError('fetch is not mocked in this test'));

/**
 * Better Auth's client captures `fetch` when it is created, at import time, so replacing the
 * global later (as `vi.stubGlobal` does) would be invisible to it. A fixed delegating `fetch`
 * is installed once, before the app modules load, and tests swap the handler behind it.
 */
export function setFetchHandler(handler: FetchHandler): void {
  fetchHandler = handler;
}
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => fetchHandler(input, init);

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!('ResizeObserver' in globalThis)) Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom logs "not implemented" for scrollTo, which the router calls on navigation.
window.scrollTo = () => {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
if (!('createObjectURL' in URL))
  Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} });
