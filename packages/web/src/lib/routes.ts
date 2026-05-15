export function projectDashboardPath(projectId: string): string {
  return `/?project=${encodeURIComponent(projectId)}`;
}

export function projectSessionPath(projectId: string, sessionId: string): string {
  return `/?project=${encodeURIComponent(projectId)}&session=${encodeURIComponent(sessionId)}`;
}
