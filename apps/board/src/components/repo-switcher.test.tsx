// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { RepoSwitcher } from "./repo-switcher";

const repos = [
  { id: "acme", name: "Acme platform" },
  { id: "widgets", name: "Widgets" },
];

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("repo switcher", () => {
  it("stays hidden when there is one repository", () => {
    render(
      <RepoSwitcher
        repos={[{ id: "default", name: "default" }]}
        repoId="default"
        pathname="/r/default/"
      />,
    );
    expect(screen.queryByRole("combobox", { name: "Repository" })).toBeNull();
  });

  it("lists repositories and navigates to the same kind of page", async () => {
    const user = userEvent.setup();
    const visited: string[] = [];
    render(
      <RepoSwitcher
        repos={repos}
        repoId="acme"
        pathname="/r/acme/graph"
        readSearch={() => "?project=billing"}
        onNavigate={(href) => visited.push(href)}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Repository" });
    expect(select).toBeTruthy();
    await user.selectOptions(select, "widgets");
    expect(visited).toEqual(["/r/widgets/graph?project=billing"]);
    expect(localStorage.getItem("snoboard:last-repo:v1")).toBe("widgets");
  });

  it("reads the query when the repository changes, not when it rendered", async () => {
    const user = userEvent.setup();
    const visited: string[] = [];
    window.history.replaceState(null, "", "/r/acme/");
    render(<RepoSwitcher repos={repos} repoId="acme" pathname="/r/acme/" onNavigate={(href) => visited.push(href)} />);
    // The board changes filters with pushState and does not rerender the header.
    window.history.pushState(null, "", "/r/acme/?project=billing&open=acme-001");
    await user.selectOptions(screen.getByRole("combobox", { name: "Repository" }), "widgets");
    expect(visited).toEqual(["/r/widgets/?project=billing"]);
  });
});
