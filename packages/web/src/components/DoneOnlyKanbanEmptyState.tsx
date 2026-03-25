import { EmptyState } from "./EmptyState";

interface DoneOnlyKanbanEmptyStateProps {
  allProjectsView: boolean;
  hasKanbanSessions: boolean;
  doneCount: number;
}

export function DoneOnlyKanbanEmptyState({
  allProjectsView,
  hasKanbanSessions,
  doneCount,
}: DoneOnlyKanbanEmptyStateProps) {
  if (allProjectsView || hasKanbanSessions || doneCount === 0) {
    return null;
  }

  return (
    <EmptyState message="All sessions are done — nothing left in the kanban." />
  );
}
