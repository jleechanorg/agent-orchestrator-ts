import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DirectTerminal } from "../DirectTerminal";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock xterm dynamic imports so Promise.all resolves in useEffect
const mockDisposable = { dispose: vi.fn() };

vi.mock("xterm", () => ({
  Terminal: class MockTerminal {
    open = vi.fn();
    loadAddon = vi.fn();
    dispose = vi.fn();
    write = vi.fn();
    writeln = vi.fn();
    clear = vi.fn();
    focus = vi.fn();
    cols = 80;
    rows = 24;
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => "");
    clearSelection = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    onData = vi.fn(() => mockDisposable);
    onResize = vi.fn(() => mockDisposable);
    onSelectionChange = vi.fn(() => mockDisposable);
    parser = {
      registerCsiHandler: vi.fn(() => mockDisposable),
      registerOscHandler: vi.fn(() => mockDisposable),
    };
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    dispose = vi.fn();
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    activate = vi.fn();
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class MockWebLinksAddon {
    dispose = vi.fn();
    activate = vi.fn();
  },
}));

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  binaryType = "arraybuffer";
  constructor(public url: string) {
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.({ type: "open" } as Event);
    }, 0);
  }
}

let wsInstance: MockWebSocket | null = null;

beforeEach(() => {
  // Mock clipboard for OSC 52 handler
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    writable: true,
    configurable: true,
  });

  global.WebSocket = function (url: string) {
    wsInstance = new MockWebSocket(url);
    return wsInstance as unknown as WebSocket;
  } as any;
  global.WebSocket.CONNECTING = 0;
  global.WebSocket.OPEN = 1;
  global.WebSocket.CLOSED = 2;
});

afterEach(() => {
  wsInstance = null;
});

describe("DirectTerminal rendering", () => {
  it("shows Connecting status initially, then Connected after WebSocket opens", async () => {
    render(<DirectTerminal sessionId="session-1" />);

    expect(screen.getByText(/Connecting/)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it("shows error status when WebSocket fails with permanent close code", async () => {
    render(<DirectTerminal sessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    }, { timeout: 3000 });

    wsInstance!.readyState = MockWebSocket.CLOSED;
    act(() => {
      wsInstance!.onerror?.({ type: "error" } as Event);
      wsInstance!.onclose?.({ type: "close", code: 4001, reason: "Auth failure" } as CloseEvent);
    });

    await waitFor(() => {
      expect(screen.getByText(/Auth failure/)).toBeInTheDocument();
    });
  });

  it("renders with orchestrator variant chrome", async () => {
    render(<DirectTerminal sessionId="session-1" variant="orchestrator" />);

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it("toggles fullscreen on button click", async () => {
    render(<DirectTerminal sessionId="session-1" startFullscreen={false} />);

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    }, { timeout: 3000 });

    const fullscreenButton = screen.getByRole("button", { name: /fullscreen/i });
    fireEvent.click(fullscreenButton);

    expect(screen.getByRole("button", { name: /exit fullscreen/i })).toBeInTheDocument();
  });
});
