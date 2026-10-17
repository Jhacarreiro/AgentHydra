"""Offline: an edit or shell task on a Free account works in a scratch copy of its folder (scratch.py, free_route.py),
against the fake AgentHydra of test_free_route. What a failed leg did must never reach the real folder; what an accepted
leg did must land there exactly, and only where the real folder did not move meanwhile."""
from __future__ import annotations

import asyncio
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from hswarm import config, free_route, scratch  # noqa: E402
from hswarm.spec import Task  # noqa: E402
from hswarm.tools import Sandbox  # noqa: E402
from test_free_route import fake  # noqa: E402,F401 - the fake AgentHydra fixture

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="the scratch copy of a checkout is a git worktree")


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", "-c", "user.email=owner@example.com", "-c", "user.name=Example Owner",
                           "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", *args],
                          cwd=cwd, capture_output=True, text=True, check=True).stdout


def _tree(root: Path) -> dict[str, str]:
    """Every file under a folder but .git, by its sha256: the folder's whole state."""
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob("*")) if p.is_file() and ".git" not in p.relative_to(root).parts}


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A checkout with a committed file, a modified tracked file, an untracked file and an ignored brief, as a task's
    folder usually is; every scratch copy goes under the test's own folder."""
    monkeypatch.setattr(scratch, "ROOT", tmp_path / "scratch-root")
    monkeypatch.setattr(config, "ROUTE_VIA_FREE_TOOL_PROFILES", ("general",))
    monkeypatch.setattr(config, "ROUTE_VIA_FREE_EDIT_PROFILES", ("general",))
    monkeypatch.setattr(config, "ROUTE_VIA_FREE_SHELL_PROFILES", ("general",))
    monkeypatch.setattr(config, "ROUTE_VIA_FREE_TOOL_ASKS", {})
    monkeypatch.setattr(config, "ROUTE_VIA_FREE_CHECK_PROFILES", ())
    monkeypatch.setattr(scratch, "_REFUSED", {})
    r = tmp_path / "repo"
    r.mkdir()
    _git(r, "init", "-q")
    (r / "notes.txt").write_bytes(b"the answer is 42\n")
    (r / "keep.txt").write_bytes(b"committed\n")
    (r / ".gitignore").write_bytes(b"tmp/\n")
    _git(r, "add", "-A")
    _git(r, "commit", "-q", "-m", "start")
    (r / "keep.txt").write_bytes(b"committed, then changed by hand\n")  # dirty: the copy must start from this
    (r / "draft.txt").write_bytes(b"untracked draft\n")
    (r / "tmp").mkdir()
    (r / "tmp" / "brief.md").write_bytes(b"Change 42 to 43 in notes.txt.\n")
    return r


def _edit_task(repo: Path, tools: str = "edit", **kw) -> Task:
    spec = {"id": "t0", "prompt": f"Do what {repo / 'tmp' / 'brief.md'} says.", "tools": tools, "model": "deepseek-flash",
            "cwd": str(repo), "timeout_s": 60, **kw}
    task = Task.from_dict(spec, {}, 0)
    task.profile = "general"
    return task


EDIT = '<tool_call>{"name": "edit_file", "arguments": {"path": "notes.txt", "old_string": "42", "new_string": "43"}}</tool_call>'
NEW = '<tool_call>{"name": "write_file", "arguments": {"path": "added.txt", "content": "made by the leg\\n"}}</tool_call>'
DRAFT = ('<tool_call>{"name": "edit_file", "arguments": {"path": "keep.txt", "old_string": "by hand", '
         '"new_string": "by hand and by the leg"}}</tool_call>')


def _consult(task):
    return asyncio.run(free_route.consult("j1", task))


def _no_scratch_left(repo: Path, root: Path) -> None:
    assert not root.exists() or not any(root.iterdir())
    assert len([ln for ln in _git(repo, "worktree", "list", "--porcelain").splitlines() if ln.startswith("worktree ")]) == 1


def test_a_failed_free_edit_leg_leaves_the_real_folder_unchanged(fake, repo):
    # The leg edits a committed file, edits the dirty one, creates a file and runs a shell that writes another, then its
    # account fails the turn: the task goes to its other routes with the folder exactly as it was.
    shell = '<tool_call>{"name": "bash", "arguments": {"command": "echo shell > from_shell.txt"}}</tool_call>'
    before = _tree(repo)
    f = fake(reply=[EDIT + "\n" + DRAFT + "\n" + NEW + "\n" + shell, "never answered"], state=["done", "failed"])
    res, note = _consult(_edit_task(repo, tools="all"))
    assert res is None and note["free_miss"] and note["via"] == "api"
    assert len(f.chats) == 2  # the leg did run its tools before it failed
    assert _tree(repo) == before
    _no_scratch_left(repo, scratch.ROOT)


def test_an_ok_free_edit_legs_diff_lands(fake, repo):
    f = fake(reply=[EDIT + "\n" + DRAFT + "\n" + NEW, "Done: 42 is 43 now."])
    res, note = _consult(_edit_task(repo))
    assert note is None and res.status == "ok" and res.answer == "Done: 42 is 43 now."
    assert (repo / "notes.txt").read_bytes() == b"the answer is 43\n"
    assert (repo / "keep.txt").read_bytes() == b"committed, then changed by hand and by the leg\n"  # from the dirty copy
    assert (repo / "added.txt").read_bytes() == b"made by the leg\n"
    assert (repo / "draft.txt").read_bytes() == b"untracked draft\n" and (repo / "tmp" / "brief.md").is_file()
    assert res.files_changed == ["added.txt", "keep.txt", "notes.txt"] and res.selection["route"]["landed"] == 3
    # The leg was shown the copy, never the real folder: its brief's path was rewritten, and the ignored brief is there.
    first = f.chats[0]["tasks"][0]["prompt"]
    assert str(repo) not in first and repo.as_posix() not in first and "brief.md" in first
    _no_scratch_left(repo, scratch.ROOT)


def test_a_free_edit_leg_whose_file_changed_meanwhile_lands_nothing(fake, repo, monkeypatch):
    # Someone else edits notes.txt while the leg works: none of the leg's changes land, not even its new file.
    land = free_route._land

    def raced(task, scr, res):
        (repo / "notes.txt").write_bytes(b"someone else's edit\n")
        return land(task, scr, res)

    monkeypatch.setattr(free_route, "_land", raced)
    fake(reply=[EDIT + "\n" + NEW, "Done."])
    res, note = _consult(_edit_task(repo))
    assert res is None and note["free_kind"] == "conflict" and "notes.txt" in note["error"]
    assert (repo / "notes.txt").read_bytes() == b"someone else's edit\n" and not (repo / "added.txt").exists()
    _no_scratch_left(repo, scratch.ROOT)


def test_an_edit_task_goes_to_free_only_where_a_scratch_copy_holds(repo, monkeypatch):
    monkeypatch.setenv("AGENTHYDRA_URL", "http://127.0.0.1:9")
    assert free_route.eligible(_edit_task(repo))
    assert not free_route.eligible(_edit_task(repo, shell_grants=["git commit"]))  # a commit would leave the copy
    monkeypatch.setattr(config, "ROUTE_VIA_FREE_SHELL_PROFILES", ())
    assert not free_route.eligible(_edit_task(repo, tools="all")) and free_route.eligible(_edit_task(repo))
    scratch.note_refused(str(repo), "too big")
    assert not free_route.eligible(_edit_task(repo))


def test_a_scratch_legs_shell_may_not_name_the_real_folder(repo):
    scr = scratch.open_scratch(str(repo))
    try:
        token = scratch.SHELL_GUARD.set(scr.real_rx)
        try:
            sb = Sandbox(scr.cwd)
        finally:
            scratch.SHELL_GUARD.reset(token)
        for command in (f"echo x > {repo.as_posix()}/notes.txt", f"cat '{repo}\\notes.txt'"):
            assert asyncio.run(sb.t_bash(command)).startswith("ERROR: this run works in a copy")
        assert Sandbox(scr.cwd).scratch_refusal(f"cat {repo.as_posix()}/notes.txt") is None  # no guard outside a leg
    finally:
        scr.drop()


def test_the_leg_sees_the_copy_and_its_answer_names_the_real_folder(repo):
    scr = scratch.open_scratch(str(repo / "tmp"))
    try:
        assert scr.cwd == scr.base / "tmp" and (scr.cwd / "brief.md").is_file()
        for written in (str(repo / "notes.txt"), repo.as_posix() + "/notes.txt"):
            seen = scr.to_scratch(f"open {written} now")
            assert str(repo) not in seen and repo.as_posix() not in seen and "notes.txt now" in seen
            assert scr.restore(seen) == f"open {written} now"
        assert scr.to_scratch(f"{repo}-other/x") == f"{repo}-other/x"  # a longer name is another folder
    finally:
        scr.drop()


def test_a_folder_that_is_no_checkout_is_copied_with_its_checkouts_as_worktrees(tmp_path, repo):
    top = tmp_path / "project"  # holds the checkout and a plain file, like a project folder of several repos
    top.mkdir()
    repo = Path(shutil.move(str(repo), str(top / "repo")))
    (top / "plan.md").write_bytes(b"the plan\n")
    scr = scratch.open_scratch(str(top))
    try:
        assert (scr.base / "plan.md").read_bytes() == b"the plan\n"
        assert (scr.base / "repo" / "keep.txt").read_bytes() == b"committed, then changed by hand\n"
        (scr.base / "plan.md").write_bytes(b"the plan, edited\n")
        (scr.base / "repo" / "notes.txt").write_bytes(b"the answer is 44\n")
        changes = scr.changes()
        assert sorted(c.real.relative_to(top).as_posix() for c in changes) == ["plan.md", "repo/notes.txt"]
        scr.land(changes)
        assert (top / "plan.md").read_bytes() == b"the plan, edited\n" and (repo / "notes.txt").read_bytes() == b"the answer is 44\n"
    finally:
        scr.drop()
    _no_scratch_left(repo, scratch.ROOT)


def test_a_checkout_tracking_more_than_a_copy_takes_is_never_copied(tmp_path, repo, monkeypatch):
    monkeypatch.setattr(scratch, "TRACKED_TOTAL_FILES", 2)  # the checkout tracks 3
    with pytest.raises(scratch.ScratchRefused):
        scratch.open_scratch(str(repo))  # the task's own checkout: no copy, the task takes its other routes
    _no_scratch_left(repo, scratch.ROOT)
    top = tmp_path / "project"
    top.mkdir()
    repo = Path(shutil.move(str(repo), str(top / "repo")))
    (top / "plan.md").write_bytes(b"the plan\n")
    scr = scratch.open_scratch(str(top))
    try:
        assert (scr.base / "plan.md").exists() and not (scr.base / "repo").exists()
        assert scr.to_scratch(f"read {repo / 'notes.txt'}") == f"read {repo / 'notes.txt'}"  # read where it is
    finally:
        scr.drop()
    _no_scratch_left(repo, scratch.ROOT)
