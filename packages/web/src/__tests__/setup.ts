import { expect, vi } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);

// jsdom doesn't provide EventSource — provide a minimal mock that
// works with `new EventSource(url)`.  Individual tests that need to
// control EventSource instances can assign `global.EventSource` in
// their own `beforeEach`.
if (typeof globalThis.EventSource === "undefined") {
  const EventSourceMock = function (this: any, _url?: string) {
    this.onmessage = null;
    this.onerror = null;
    this.close = vi.fn();
    this.readyState = 0;
    this.url = _url ?? "";
    this.withCredentials = false;
  } as any as typeof EventSource;
  EventSourceMock.CONNECTING = 0;
  EventSourceMock.OPEN = 1;
  EventSourceMock.CLOSED = 2;
  globalThis.EventSource = EventSourceMock;
}
