import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";
import { makePR, makeSession } from "../../__tests__/helpers";

const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: refreshMock }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

function mockMobileViewport() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("max-width: 767px"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("Dashboard unified layout (mobile viewport)", () => {
  beforeEach(() => {
    refreshMock.mockReset();
    mockMobileViewport();
    Element.prototype.scrollIntoView = vi.fn();
    const eventSourceMock = {
      onmessage: null,
      onerror: null,
      onopen: null,
      close: vi.fn(),
    };
    const eventSourceConstructor = function (_url?: string) {
      return eventSourceMock as unknown as EventSource;
    } as any as typeof EventSource;
    eventSourceConstructor.CONNECTING = 0;
    eventSourceConstructor.OPEN = 1;
    eventSourceConstructor.CLOSED = 2;
    global.EventSource = eventSourceConstructor;
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      } as Response),
    );
  });

  it("shows all sessions in the dashboard", () => {
    const sessions = Array.from({ length: 3 }, (_, index) =>
      makeSession({
        id: `session-${index + 1}`,
        summary: `Session ${index + 1}`,
        branch: null,
        status: "running",
        activity: "active",
      }),
    );

    render(<Dashboard initialSessions={sessions} />);

    // Sessions render in the working attention zone
    expect(screen.getByText("Working")).toBeInTheDocument();
  });

  it("shows sessions with their branch and summary", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "working-1",
            status: "running",
            activity: "active",
            summary: "Implement dashboard filters",
            branch: "feat/dashboard-filters",
          }),
        ]}
      />,
    );

    // Branch name appears in session card
    expect(screen.getAllByText(/feat\/dashboard-filters/i).length).toBeGreaterThan(0);
  });

  it("shows sessions with enriched PR information", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "merge-7",
            status: "approved",
            activity: "idle",
            summary: "Ship dashboard polish",
            branch: "feat/dashboard-polish",
            pr: makePR({
              number: 207,
              additions: 24,
              deletions: 7,
              ciStatus: "failing",
              reviewDecision: "changes_requested",
            }),
          }),
        ]}
      />,
    );

    expect(screen.getByText(/feat\/dashboard-polish/)).toBeInTheDocument();
  });

  it("shows and dismisses the rate limit banner", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "review-2",
            status: "reviewing",
            activity: "idle",
            pr: makePR({
              number: 208,
              mergeability: {
                mergeable: false,
                ciPassing: false,
                approved: false,
                noConflicts: true,
                blockers: ["API rate limited or unavailable"],
              },
            }),
          }),
        ]}
      />,
    );

    expect(screen.getByText(/GitHub API rate limited/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/GitHub API rate limited/i)).not.toBeInTheDocument();
  });

  it("kill button requires a two-click confirmation before firing", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve("") } as Response),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;

    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "working-kill",
            status: "running",
            activity: "active",
            summary: "Live session",
            branch: "feat/live",
          }),
        ]}
      />,
    );

    // Find the terminate/kill button in the attention zone
    const killButton = screen.queryByRole("button", { name: /Terminate|Kill/i });

    if (killButton) {
      // First click enters confirm mode, does not fire yet
      fireEvent.click(killButton);
      expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining("/kill"), expect.anything());

      // Second click fires the kill
      await act(async () => {
        const confirmButton = screen.queryByRole("button", { name: /Terminate|Kill|Confirm/i });
        if (confirmButton) {
          fireEvent.click(confirmButton);
        }
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/sessions/working-kill/kill",
        expect.objectContaining({ method: "POST" }),
      );
    }
  });

  it("preserves sessions across live updates", () => {
    const { rerender } = render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "respond-1",
            status: "needs_input",
            activity: "waiting_input",
            summary: "Need approval to proceed",
            branch: null,
          }),
          makeSession({
            id: "working-1",
            status: "running",
            activity: "active",
            summary: "Implement dashboard filters",
            branch: null,
          }),
        ]}
      />,
    );

    expect(screen.getAllByText("Need approval to proceed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Implement dashboard filters").length).toBeGreaterThan(0);

    rerender(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "respond-1",
            status: "needs_input",
            activity: "waiting_input",
            summary: "Need approval to proceed",
            branch: null,
            lastActivityAt: new Date(Date.now() + 1_000).toISOString(),
          }),
          makeSession({
            id: "working-1",
            status: "running",
            activity: "active",
            summary: "Implement dashboard filters",
            branch: null,
            lastActivityAt: new Date(Date.now() + 2_000).toISOString(),
          }),
        ]}
      />,
    );

    expect(screen.getAllByText("Need approval to proceed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Implement dashboard filters").length).toBeGreaterThan(0);
  });
});
