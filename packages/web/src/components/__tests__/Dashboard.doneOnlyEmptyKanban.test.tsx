import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { DoneOnlyKanbanEmptyState } from "@/components/DoneOnlyKanbanEmptyState";

describe("DoneOnlyKanbanEmptyState", () => {
  it("shows EmptyState message when kanban is empty and done sessions exist", () => {
    render(
      <DoneOnlyKanbanEmptyState
        allProjectsView={false}
        hasKanbanSessions={false}
        doneCount={2}
      />,
    );

    expect(
      screen.getByText("All sessions are done — nothing left in the kanban."),
    ).toBeInTheDocument();
  });

  it("renders done sessions section below EmptyState when done sessions exist", () => {
    render(
      <DoneOnlyKanbanEmptyState
        allProjectsView={false}
        hasKanbanSessions={false}
        doneCount={1}
      />,
    );

    expect(
      screen.getByText("All sessions are done — nothing left in the kanban."),
    ).toBeInTheDocument();
  });

  it("does not show EmptyState when kanban has working sessions", () => {
    render(
      <DoneOnlyKanbanEmptyState
        allProjectsView={false}
        hasKanbanSessions={true}
        doneCount={1}
      />,
    );

    expect(
      screen.queryByText("All sessions are done — nothing left in the kanban."),
    ).not.toBeInTheDocument();
  });

  it("does not show EmptyState when there are no done sessions", () => {
    render(
      <DoneOnlyKanbanEmptyState
        allProjectsView={false}
        hasKanbanSessions={false}
        doneCount={0}
      />,
    );

    expect(
      screen.queryByText("All sessions are done — nothing left in the kanban."),
    ).not.toBeInTheDocument();
  });

  it("returns null when allProjectsView is true", () => {
    const { container } = render(
      <DoneOnlyKanbanEmptyState
        allProjectsView={true}
        hasKanbanSessions={false}
        doneCount={5}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
