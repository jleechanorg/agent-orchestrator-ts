import { render, screen } from "@testing-library/react";
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

describe("Dashboard empty state", () => {
  it("shows 'no sessions' when there are no sessions", () => {
    render(<Dashboard initialSessions={[]} />);

    expect(screen.getByText("no sessions")).toBeInTheDocument();
  });

  it("does not show 'no sessions' when sessions exist", () => {
    const sessions = [
      makeSession({
        id: "working-1",
        status: "running",
        activity: "active",
        summary: "Implement dashboard filters",
      }),
    ];

    render(<Dashboard initialSessions={sessions} />);

    expect(screen.queryByText("no sessions")).not.toBeInTheDocument();
  });

  it("shows DoneOnlyKanbanEmptyState when only done sessions exist", () => {
    const doneSession = makeSession({
      id: "done-1",
      status: "merged",
      activity: "exited",
    });

    render(<Dashboard initialSessions={[doneSession]} />);

    // DoneOnlyKanbanEmptyState shows when allProjectsView=false, hasKanbanSessions=false, doneCount>0
    expect(screen.getByText(/All sessions are done/)).toBeInTheDocument();
  });

  it("does not show DoneOnlyKanbanEmptyState when kanban sessions exist", () => {
    const workingSession = makeSession({
      id: "working-1",
      status: "running",
      activity: "active",
    });
    const doneSession = makeSession({
      id: "done-1",
      status: "merged",
      activity: "exited",
    });

    render(<Dashboard initialSessions={[workingSession, doneSession]} />);

    expect(screen.queryByText(/All sessions are done/)).not.toBeInTheDocument();
  });

  it("does not show DoneOnlyKanbanEmptyState in all-projects view", () => {
    const doneSession = makeSession({
      id: "done-1",
      status: "merged",
      activity: "exited",
    });

    render(
      <Dashboard
        initialSessions={[doneSession]}
        projects={[
          { id: "project-a", name: "Project A" },
          { id: "project-b", name: "Project B" },
        ]}
      />,
    );

    expect(screen.queryByText(/All sessions are done/)).not.toBeInTheDocument();
  });

  it("renders the project heading", () => {
    render(<Dashboard initialSessions={[]} projectName="My Project" />);

    expect(screen.getByText("My Project")).toBeInTheDocument();
  });

  it("renders 'Orchestrator' as default heading when no projectName", () => {
    render(<Dashboard initialSessions={[]} />);

    expect(screen.getByText("Orchestrator")).toBeInTheDocument();
  });
});
