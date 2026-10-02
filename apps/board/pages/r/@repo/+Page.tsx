import { Board } from "@/features/board/Board";
import { RepoScope } from "@/features/repo/context";

export function Page() {
  return (
    <RepoScope>
      <Board />
    </RepoScope>
  );
}
