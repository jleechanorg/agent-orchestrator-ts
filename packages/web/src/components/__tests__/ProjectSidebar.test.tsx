import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSidebar } from "../ProjectSidebar";
import type { ProjectInfo } from "../../lib/project-name";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
}));

const PROJECT_A: ProjectInfo = { id: "proj-a", name: "Project Alpha" };
const PROJECT_B: ProjectInfo = { id: "proj-b", name: "Project Beta" };
const PROJECT_C: ProjectInfo = { id: "proj-c", name: "Project Gamma" };

describe("ProjectSidebar", () => {
  beforeEach(() => {
    pushMock.mockReset();
  });

  describe("rendering conditions", () => {
    it("returns null when there are zero projects", () => {
      const { container } = render(<ProjectSidebar projects={[]} activeProjectId={undefined} />);
      expect(container.innerHTML).toBe("");
    });

    it("returns null when there is only one project", () => {
      const { container } = render(
        <ProjectSidebar projects={[PROJECT_A]} activeProjectId="proj-a" />,
      );
      expect(container.innerHTML).toBe("");
    });

    it("renders when there are two or more projects", () => {
      render(<ProjectSidebar projects={[PROJECT_A, PROJECT_B]} activeProjectId={undefined} />);
      expect(screen.getByText("Projects")).toBeInTheDocument();
    });
  });

  describe("project list display", () => {
    it("renders the Projects header", () => {
      render(<ProjectSidebar projects={[PROJECT_A, PROJECT_B]} activeProjectId={undefined} />);
      expect(screen.getByText("Projects")).toBeInTheDocument();
    });

    it("renders the All Projects button", () => {
      render(<ProjectSidebar projects={[PROJECT_A, PROJECT_B]} activeProjectId={undefined} />);
      expect(screen.getByText("All Projects")).toBeInTheDocument();
    });

    it("renders each project name as a button", () => {
      render(<ProjectSidebar projects={[PROJECT_A, PROJECT_B, PROJECT_C]} activeProjectId={undefined} />);
      expect(screen.getByText("Project Alpha")).toBeInTheDocument();
      expect(screen.getByText("Project Beta")).toBeInTheDocument();
      expect(screen.getByText("Project Gamma")).toBeInTheDocument();
    });

    it("renders all project buttons including All Projects", () => {
      render(<ProjectSidebar projects={[PROJECT_A, PROJECT_B]} activeProjectId={undefined} />);
      const buttons = screen.getAllByRole("button");
      // All Projects + 2 project buttons
      expect(buttons).toHaveLength(3);
    });
  });

  describe("active project highlighting", () => {
    it("highlights All Projects when activeProjectId is undefined", () => {
      render(<ProjectSidebar projects={[PROJECT_A, PROJECT_B]} activeProjectId={undefined} />);
      const allButton = screen.getByText("All Projects").closest("button")!;
      expect(allButton.className).toContain("accent");
    });

    it("highlights All Projects when activeProjectId is 'all'", () => {
      render(<ProjectSidebar projects={[PROJECT_A, PROJECT_B]} activeProjectId="all" />);
      const allButton = screen.getByText("All Projects").closest("button")!;
      expect(allButton.className).toContain("accent");
    });

    it("highlights the active project by id", () => {
      render(<ProjectSidebar projects={[PROJECT_A, PROJECT_B]} activeProjectId="proj-a" />);
      const alphaButton = screen.getByText("Project Alpha").closest("button")!;
      expect(alphaButton.className).toContain("accent");
    });

    it("does not highlight inactive projects", () => {
      render(<ProjectSidebar projects={[PROJECT_A, PROJECT_B]} activeProjectId="proj-a" />);
      const betaButton = screen.getByText("Project Beta").closest("button")!;
      expect(betaButton.className).not.toContain("accent");
    });

    it("does not highlight All Projects when a specific project is active", () => {
      render(<ProjectSidebar projects={[PROJECT_A, PROJECT_B]} activeProjectId="proj-b" />);
      const allButton = screen.getByText("All Projects").closest("button")!;
      expect(allButton.className).not.toContain("accent");
    });
  });

  describe("navigation", () => {
    it("navigates to all projects view when All Projects is clicked", () => {
      render(<ProjectSidebar projects={[PROJECT_A, PROJECT_B]} activeProjectId="proj-a" />);
      fireEvent.click(screen.getByText("All Projects"));
      expect(pushMock).toHaveBeenCalledWith("/?project=all");
    });

    it("navigates to a specific project when its button is clicked", () => {
      render(<ProjectSidebar projects={[PROJECT_A, PROJECT_B]} activeProjectId={undefined} />);
      fireEvent.click(screen.getByText("Project Alpha"));
      expect(pushMock).toHaveBeenCalledWith("/?project=proj-a");
    });

    it("encodes project id in the URL", () => {
      const project: ProjectInfo = { id: "my project", name: "My Project" };
      render(<ProjectSidebar projects={[project, PROJECT_B]} activeProjectId={undefined} />);
      fireEvent.click(screen.getByText("My Project"));
      expect(pushMock).toHaveBeenCalledWith("/?project=my%20project");
    });
  });
});
