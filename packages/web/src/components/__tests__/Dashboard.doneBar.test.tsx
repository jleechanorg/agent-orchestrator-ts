import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";
import { makeSession } from "../../__tests__/helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  const eventSourceMock = {
    onmessage: null,
    onerror: null,
    close: vi.fn(),
  };
  const eventSourceConstructor = function (_url?: string) {
    return eventSourceMock as unknown as EventSource;
  } as any as typeof EventSource;
  eventSourceConstructor.CONNECTING = 0;
  eventSourceConstructor.OPEN = 1;
  eventSourceConstructor.CLOSED = 2;
  global.EventSource = eventSourceConstructor;
  global.fetch = vi.fn();
});

describe("Dashboard done sessions", () => {
  it("renders done sessions in an AttentionZone", () => {
    const doneSession = makeSession({
      id: "done-1",
      status: "merged",
      activity: "exited",
      branch: "feat/done",
    });

    render(<Dashboard initialSessions={[doneSession]} />);

    // Done sessions appear in an AttentionZone with "Done" label
    expect(screen.getByText("Done")).toBeInTheDocument();
    // The session summary or branch should be visible after expanding
  });

  it("shows the Done attention zone collapsed by default and expands on click", () => {
    const doneSession = makeSession({
      id: "done-2",
      status: "merged",
      activity: "exited",
      summary: "Finished task",
    });

    render(<Dashboard initialSessions={[doneSession]} />);

    // Done zone is collapsed by default — toggle button shows "Done"
    const doneButton = screen.getByText("Done").closest("button")!;
    expect(doneButton).toBeInTheDocument();

    // Click to expand
    fireEvent.click(doneButton);
    expect(screen.getByText("Finished task")).toBeInTheDocument();
  });

  it("does not show empty state when only done sessions exist", () => {
    const doneSession = makeSession({
      id: "done-3",
      status: "merged",
      activity: "exited",
    });

    render(<Dashboard initialSessions={[doneSession]} />);

    expect(screen.queryByText(/No active sessions/i)).not.toBeInTheDocument();
  });
});
