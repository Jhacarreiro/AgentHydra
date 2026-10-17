"""A scratch copy of a task's folder, for a Free leg that may edit files or run a shell (free_route.py).

Why: a Free leg that fails falls back to the task's other routes, and an edit it had already made in the real folder
would be left behind for them (config.ROUTE_VIA_FREE_EDIT_PROFILES). So such a leg runs in a scratch copy, and its
changes reach the real folder only when the leg is accepted, and only where the real folder has not moved meanwhile.

The copy (open_scratch):
- a cwd inside a git checkout: a detached worktree of that checkout at HEAD made without a checkout (its hooks off), its
  index read from HEAD, and its files copied byte for byte from the real checkout: every tracked file as it is now (a
  checkout would rewrite line endings the real file does not have), its untracked files, and its small ignored files
  (IGNORED_MAX_*; never node_modules, target and the like, toolspecs.IGNORED_DIRS), so a brief kept in an ignored tmp/
  is there too;
- a cwd that is no checkout: a plain copy of it, each git checkout inside it made a worktree as above. A folder too big to
  copy whole (COPY_MAX_*) keeps only its top-level entries that fit (DIR_MAX_*) and its checkouts (REPOS_MAX); its other
  top-level folders, and its dot-folders, stay out as REFERENCES: the leg's file tools read them at their real paths and
  nothing may write them.

The leg sees only the copy: its prompt, system text and paths have the real folder replaced by the copy (to_scratch), a
reference keeps its real path, and its shell may not name the real folder at all (SHELL_GUARD, tools.Sandbox). Every file
the copy starts with is fingerprinted (sha256 of its bytes), so afterwards `changes` lists exactly what the leg changed,
created or deleted, by file tool or by shell. `land` writes them to the real folder only when every touched real file is
still byte for byte what the copy started from, and otherwise writes none of them (EditConflict). `drop` removes the
copy and its worktrees; `sweep` removes copies a dead process left behind.
"""
from __future__ import annotations

import contextvars
import difflib
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from .procgate import CREATE_NO_WINDOW
from .toolspecs import IGNORED_DIRS

ROOT = Path(tempfile.gettempdir()) / "hswarm-scratch"
FILE_MAX_BYTES = 4 * 2**20  # a bigger file is never copied: a source file this size is generated or data
COPY_MAX_FILES, COPY_MAX_BYTES = 20_000, 300 * 2**20  # a folder that is no checkout and fits is copied whole
DIR_MAX_FILES, DIR_MAX_BYTES = 3_000, 60 * 2**20  # else each top-level folder that fits is copied; the rest are references
IGNORED_MAX_FILES, IGNORED_MAX_BYTES = 2_000, 50 * 2**20  # a checkout's ignored files copied into its worktree
TRACKED_MAX_BYTES = 64 * 2**20  # a tracked file bigger than this is left out of the copy (Unit.left)
REPOS_MAX = 6  # checkouts inside a folder that is no checkout made worktrees; past it, they stay out
STALE_S = 6 * 3600  # a copy this old whose process is gone is swept
REFUSED_S = 600.0  # a folder no copy could be made of is not tried again for this long (free_route.eligible)
GIT_TIMEOUT_S = 180
MARK = ".hswarm-scratch.json"  # in each copy's own folder: its pid and its worktrees, for sweep

# The real folder's pattern while a scratch leg runs: tools.Sandbox reads it when it opens, and its bash refuses any
# command that names the real folder (a leg's shell must work in the copy). Set by free_route around the leg.
SHELL_GUARD: contextvars.ContextVar[re.Pattern | None] = contextvars.ContextVar("hswarm_scratch_guard", default=None)

_REFUSED: dict[str, tuple[float, str]] = {}  # real folder -> (when, why) no copy could be made of it
_REPO_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_LOCK = threading.Lock()


class ScratchRefused(RuntimeError):
    """No scratch copy can be made of this folder (too big, a drive root, git failed): the task keeps its other routes."""


class EditConflict(RuntimeError):
    """A file the leg changed changed in the real folder too since the copy was made: none of the leg's changes land."""


@dataclass
class Unit:
    """One part of the copy: a worktree of a checkout (`git`), or plain copied files. `base` maps each path (POSIX,
    relative to `copy`) the copy started with to its fingerprint (_sha; None: a tracked file the real checkout has
    deleted). `left` holds tracked paths not copied (a folder such as a submodule, or a file over TRACKED_MAX_BYTES):
    their absence in the copy is no change of the leg's."""
    real: Path
    copy: Path
    git: bool
    base: dict[str, str | None] = field(default_factory=dict)
    left: set[str] = field(default_factory=set)


@dataclass
class Change:
    unit: Unit
    rel: str
    start: str | None  # sha256 of the copy's bytes when it was made (None: no such file)
    now: str | None

    @property
    def real(self) -> Path:
        return self.unit.real / self.rel

    @property
    def copy(self) -> Path:
        return self.unit.copy / self.rel


def _sha(path: Path) -> str | None:
    """A file's fingerprint: the sha256 of its bytes, `link:<target>` for a symlink, None when there is no file."""
    try:
        if path.is_symlink():
            return "link:" + os.readlink(path)
        if not path.is_file():
            return None
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _copy_file(src: Path, dst: Path) -> str | None:
    """Copy one file's bytes (a symlink as a symlink); its fingerprint."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_symlink():
        os.symlink(os.readlink(src), dst)
        return _sha(dst)
    data = src.read_bytes()
    dst.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def _linkish(p: Path) -> bool:
    try:
        return p.is_symlink() or bool(getattr(p, "is_junction", lambda: False)())
    except OSError:
        return True


def _checkout(p: Path) -> bool:
    return (p / ".git").exists()


def _skipped(p: Path) -> bool:
    """A folder no copy walks into: a dependency or build folder, a link, or the scratch copies' own root."""
    return p.name in IGNORED_DIRS or _linkish(p) or os.path.normcase(str(p)) == os.path.normcase(str(ROOT))


def _git(cwd: Path, *args: str, env: dict | None = None, data: bool = False) -> str | bytes:
    """One git command, hidden, never prompting; raises ScratchRefused when it fails."""
    full = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1", **(env or {})}
    try:
        p = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, timeout=GIT_TIMEOUT_S, env=full,
                           creationflags=CREATE_NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise ScratchRefused(f"git {args[0]} failed in {cwd}: {type(e).__name__}") from e
    if p.returncode != 0:
        raise ScratchRefused(f"git {' '.join(args[:2])} failed in {cwd}: {p.stderr.decode('utf-8', 'replace').strip()[:200]}")
    return p.stdout if data else p.stdout.decode("utf-8", "surrogateescape")


def _repo_lock(repo: Path) -> threading.Lock:
    """One worktree add or remove at a time per checkout in this process (git names each worktree's admin folder)."""
    key = os.path.normcase(str(repo))
    with _LOCKS_LOCK:
        return _REPO_LOCKS.setdefault(key, threading.Lock())


def _rmtree(path: Path) -> None:
    def onexc(func, p, _exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass  # floor-ok: what cannot be removed now is swept later (sweep)
    if path.exists():
        shutil.rmtree(path, onexc=onexc)


def _rx(path: Path) -> re.Pattern:
    """A path as it may be written in text: either slash, a doubled backslash (JSON), the drive as `D:` or `/d` (Git
    Bash), any case; never a longer name that merely starts with it."""
    drive, rest = os.path.splitdrive(str(path))
    parts = [re.escape(p) for p in re.split(r"[\\/]+", rest) if p]
    sep = r"(?:\\\\|\\|/)"
    head = rf"(?:{re.escape(drive)}{sep}|/{re.escape(drive[:1].lower())}/|/mnt/{re.escape(drive[:1].lower())}/)" if drive else sep
    return re.compile(head + sep.join(parts) + r"(?![\w-]|\.\w)", re.I)


def _styled(match: str, target: Path) -> str:
    """`target` written the way `match` (a path in some text) was written: Git Bash's /c/... or a drive with its slash."""
    drive, rest = os.path.splitdrive(str(target))
    parts = [p for p in re.split(r"[\\/]+", rest) if p]
    if drive and re.match(r"/(mnt/)?[a-zA-Z]/", match):
        return ("/mnt/" if match.startswith("/mnt/") else "/") + drive[:1].lower() + "/" + "/".join(parts)
    sep = "\\\\" if "\\\\" in match else "\\" if "\\" in match else "/"
    return (drive + sep if drive else sep) + sep.join(parts)


class Scratch:
    """A scratch copy of the folder `real` (a checkout's top, or the task's cwd when it is no checkout) at `base`."""

    def __init__(self, real: Path, base: Path, cwd_rel: str):
        self.real, self.base = real, base
        self.home = base.parent  # the copy's own folder under ROOT: the base, its mark and its empty hooks folder
        self.cwd = base / cwd_rel if cwd_rel not in ("", ".") else base
        self.units: list[Unit] = []
        self.references: set[str] = set()  # top-level names of `real` left out of the copy (casefolded)
        self.real_rx, self.base_rx = _rx(real), _rx(base)
        self._next_rx = re.compile(self.real_rx.pattern + r"(?:(?P<sep>\\\\|\\|/)(?P<next>[^\\/\s\"'`<>|*?:]+))?", re.I)

    def to_scratch(self, text):
        """`text` with the real folder written as the copy, except a path into a reference, which stays real."""
        if not isinstance(text, str) or not text:
            return text

        def one(m: re.Match) -> str:
            nxt = m.group("next")
            if nxt and nxt.casefold() in self.references:
                return m.group(0)
            head = m.group(0)[: m.start("sep") - m.start(0)] if nxt else m.group(0)
            return _styled(head, self.base) + m.group(0)[len(head):]
        return self._next_rx.sub(one, text)

    def restore(self, value):
        """`value` (text, or a list or dict of it) with the copy written as the real folder again."""
        if isinstance(value, str):
            return self.base_rx.sub(lambda m: _styled(m.group(0), self.real), value)
        if isinstance(value, list):
            return [self.restore(v) for v in value]
        if isinstance(value, dict):
            return {k: self.restore(v) for k, v in value.items()}
        return value

    def leg_fields(self, task) -> dict:
        """The task's fields for a leg in the copy: its cwd, its text and paths as the copy, the copy its only writable
        place, and the real folder a read-only root when references stay there."""
        roots = [self.to_scratch(r) for r in task.roots]
        if self.references:
            roots.append(str(self.real))
        if task.writable is None:
            writable = [str(self.base)]
        else:
            # A relative glob is the copy's (it resolves under the leg's cwd); an absolute one outside the copy is dropped,
            # so a leg never writes past it.
            writable = [g for g in (self.to_scratch(w) for w in task.writable)
                        if not os.path.isabs(g) or Path(g).resolve().is_relative_to(self.base.resolve())]
        return {"cwd": str(self.cwd), "prompt": self.to_scratch(task.prompt), "system": self.to_scratch(task.system),
                "scope": self.to_scratch(task.scope), "done_when": self.to_scratch(task.done_when), "roots": roots,
                "writable": writable, "files": [self.to_scratch(f) for f in task.files],
                "acceptance": [self.to_scratch(a) for a in task.acceptance],
                "inventory": [self.to_scratch(p) for p in task.inventory]}

    def _unit_of(self, path: Path) -> tuple[Unit, str] | None:
        """The deepest unit whose copy holds `path`, and the path relative to it."""
        best = None
        for u in self.units:
            try:
                rel = path.relative_to(u.copy)
            except ValueError:
                continue
            if best is None or len(u.copy.parts) > len(best[0].copy.parts):
                best = (u, rel.as_posix())
        return best

    def _walk(self, unit: Unit) -> set[str]:
        """The files now in a plain unit's copy, IGNORED_DIRS and other units' copies left out."""
        inner = {u.copy for u in self.units if u is not unit}
        out = set()
        for dp, dns, fns in os.walk(unit.copy):
            d = Path(dp)
            dns[:] = [n for n in dns if not _skipped(d / n) and (d / n) not in inner]
            out |= {(d / f).relative_to(unit.copy).as_posix() for f in fns if not (d == self.home and f == MARK)}
        return out

    def changes(self, written: list[str] | None = None) -> list[Change]:
        """Every file the leg changed, created or deleted in the copy. `written` (the leg's files_changed, relative to its
        cwd or absolute) adds files a checkout ignores, which its status does not list."""
        extra: dict[int, set[str]] = {}
        for w in written or ():
            p = Path(w) if os.path.isabs(w) else self.cwd / w
            hit = self._unit_of(Path(os.path.abspath(p)))
            if hit:
                extra.setdefault(id(hit[0]), set()).add(hit[1])
        out = []
        for u in self.units:
            cands = set(u.base) | extra.get(id(u), set())
            if u.git:
                status = _git(u.copy, "--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all",
                              "--no-renames", "--ignore-submodules=all")
                cands |= {e[3:] for e in status.split("\0") if len(e) > 3}
            else:
                cands |= self._walk(u)
            for rel in sorted(cands - u.left):
                if (u.copy / rel).is_dir() and not (u.copy / rel).is_symlink():
                    continue
                now, start = _sha(u.copy / rel), u.base.get(rel)
                if now != start:
                    out.append(Change(u, rel, start, now))
        return out

    def diff(self, changes: list[Change]) -> str:
        """The changes as one unified diff against the real folder (for the A/B, free_ab.py)."""
        chunks = []
        for c in changes:
            def text(p: Path) -> list[str]:
                try:
                    return p.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True) if p.is_file() else []
                except OSError:
                    return []
            name = (c.real.relative_to(self.real)).as_posix()
            chunks += difflib.unified_diff(text(c.real), text(c.copy), f"a/{name}", f"b/{name}")
        return "".join(chunks)

    def _real_bytes(self, data: bytes) -> bytes:
        """A landed file's bytes with the copy's path written as the real folder's: the leg believed the copy was its
        folder, so a path it wrote into a file names the copy."""
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return data
        return self.restore(text).encode("utf-8") if self.base_rx.search(text) else data

    def land(self, changes: list[Change]) -> list[Path]:
        """Write the changes to the real folder: all of them, or none when any touched real file is no longer what the
        copy started from (EditConflict). A write that fails midway puts back what it had already written."""
        stale = [c for c in changes if _sha(c.real) != c.start]
        if stale:
            names = ", ".join(c.real.relative_to(self.real).as_posix() for c in stale[:5])
            raise EditConflict(f"{len(stale)} file(s) changed in the real folder since the copy was made: {names}")
        done: list[tuple[Path, bytes | None]] = []
        try:
            for c in changes:
                before = c.real.read_bytes() if c.real.is_file() else None
                if c.now is None:
                    if c.real.is_file():
                        c.real.unlink()
                else:
                    c.real.parent.mkdir(parents=True, exist_ok=True)
                    tmp = c.real.with_name(f"{c.real.name}.hswarm-{uuid.uuid4().hex[:6]}")
                    if c.copy.is_symlink():
                        os.symlink(os.readlink(c.copy), tmp)
                    else:
                        tmp.write_bytes(self._real_bytes(c.copy.read_bytes()))
                    os.replace(tmp, c.real)
                done.append((c.real, before))
        except OSError:
            for path, before in reversed(done):
                try:
                    if before is None:
                        path.unlink(missing_ok=True)
                    else:
                        path.write_bytes(before)
                except OSError:
                    pass  # floor-ok: the put-back is best effort; the error below names the failed write
            raise
        return [p for p, _ in done]

    def drop(self) -> None:
        """Remove the copy: each worktree from its checkout, then the folder."""
        for u in self.units:
            if u.git:
                _unregister(u.real, u.copy)
        _rmtree(self.home)

    def _mark(self) -> None:
        doc = {"pid": os.getpid(), "made": time.time(), "real": str(self.real),
               "worktrees": [[str(u.real), str(u.copy)] for u in self.units if u.git]}
        (self.home / MARK).write_text(json.dumps(doc), encoding="utf-8")

    def _worktree(self, repo: Path, copy: Path) -> Unit:
        """A checkout as a detached worktree at its HEAD whose files are the real checkout's own bytes (see the module
        docstring): tracked, untracked, then small ignored files."""
        head = _git(repo, "rev-parse", "--verify", "-q", "HEAD").strip()
        nohooks = self.home / "nohooks"
        nohooks.mkdir(exist_ok=True)
        unit = Unit(repo, copy, git=True)
        with _repo_lock(repo):
            _git(repo, "-c", f"core.hooksPath={nohooks}", "-c", "core.longpaths=true", "worktree", "add", "--detach",
                 "--no-checkout", "--quiet", str(copy), head)
            self.units.append(unit)
            self._mark()
        _git(copy, "read-tree", head)  # the index is HEAD's; the files come from the real checkout below
        tracked = _git(repo, "--no-optional-locks", "ls-files", "-z", "--cached")
        untracked = _git(repo, "--no-optional-locks", "ls-files", "-z", "--others", "--exclude-standard")
        for rel in dict.fromkeys(tracked.split("\0")):
            src = repo / rel
            if not rel:
                continue
            if src.is_symlink() or src.is_file() and src.stat().st_size <= TRACKED_MAX_BYTES:
                unit.base[rel] = _copy_file(src, copy / rel)
            elif not src.exists():
                unit.base[rel] = None  # deleted in the real checkout: absent in the copy too
            else:
                unit.left.add(rel)  # a submodule's folder or a very big file
        for rel in untracked.split("\0"):
            src = repo / rel
            if rel and rel not in unit.base and (src.is_symlink() or src.is_file() and src.stat().st_size <= FILE_MAX_BYTES):
                unit.base[rel] = _copy_file(src, copy / rel)
        ignored = _git(repo, "--no-optional-locks", "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory")
        budget = [IGNORED_MAX_FILES, IGNORED_MAX_BYTES]
        for entry in ignored.split("\0"):
            rel = entry.rstrip("/")
            if not rel or any(part in IGNORED_DIRS for part in rel.split("/")):
                continue
            src = repo / rel
            files = [src] if src.is_file() else _files(src) if src.is_dir() and not _checkout(src) else []
            for f in files:
                size = f.stat().st_size if f.is_file() and not f.is_symlink() else FILE_MAX_BYTES + 1
                if size > FILE_MAX_BYTES or budget[0] <= 0 or budget[1] < size:
                    continue
                budget[0] -= 1
                budget[1] -= size
                r = f.relative_to(repo).as_posix()
                unit.base[r] = _copy_file(f, copy / r)
        return unit

    def _plain(self, src: Path, dst: Path, unit: Unit, repos: list[tuple[Path, Path]]) -> None:
        """Copy a folder that is no checkout into `dst` (its files into `unit`); checkouts inside it are listed in
        `repos` to be made worktrees."""
        dst.mkdir(parents=True, exist_ok=True)
        for dp, dns, fns in os.walk(src):
            d = Path(dp)
            keep = []
            for n in dns:
                p = d / n
                if _skipped(p):
                    continue
                if _checkout(p):
                    repos.append((p, dst / p.relative_to(src)))
                    continue
                keep.append(n)
            dns[:] = keep
            for f in fns:
                p = d / f
                try:
                    if _linkish(p) or p.stat().st_size > FILE_MAX_BYTES:
                        continue
                except OSError:
                    continue
                rel = (dst / p.relative_to(src)).relative_to(unit.copy).as_posix()
                unit.base[rel] = _copy_file(p, unit.copy / rel)


def _files(folder: Path):
    """The files under a folder, IGNORED_DIRS, links and checkouts left out."""
    for dp, dns, fns in os.walk(folder):
        d = Path(dp)
        dns[:] = [n for n in dns if not _skipped(d / n) and not _checkout(d / n)]
        for f in fns:
            if not _linkish(d / f):
                yield d / f


def _fits(folder: Path, max_files: int, max_bytes: int) -> tuple[bool, int, int, int]:
    """Whether a folder's copyable files (IGNORED_DIRS, links, checkouts and files over FILE_MAX_BYTES left out) fit,
    how many checkouts it holds, and the files and bytes counted; stops walking as soon as they do not fit."""
    n = b = repos = 0
    for dp, dns, fns in os.walk(folder):
        d = Path(dp)
        keep = []
        for name in dns:
            p = d / name
            if _skipped(p):
                continue
            if _checkout(p):
                repos += 1
                continue
            keep.append(name)
        dns[:] = keep
        for f in fns:
            try:
                s = (d / f).lstat().st_size
            except OSError:
                continue
            if s > FILE_MAX_BYTES:
                continue
            n, b = n + 1, b + s
            if n > max_files or b > max_bytes:
                return False, repos, n, b
    return True, repos, n, b


def _top(cwd: Path) -> Path | None:
    try:
        return Path(_git(cwd, "rev-parse", "--show-toplevel").strip()).resolve()
    except ScratchRefused:
        return None


def _unregister(repo: Path, copy: Path) -> None:
    with _repo_lock(repo):
        try:
            _git(repo, "worktree", "remove", "--force", "--force", str(copy))
        except ScratchRefused:
            _rmtree(copy)
            try:
                _git(repo, "worktree", "prune")
            except ScratchRefused:
                pass  # floor-ok: git prunes a worktree whose folder is gone on its own later


def open_scratch(cwd: str) -> Scratch:
    """A scratch copy of the folder a task with cwd `cwd` works in (see the module docstring). Raises ScratchRefused."""
    real_cwd = Path(cwd).resolve()
    if not real_cwd.is_dir():
        raise ScratchRefused(f"{cwd} is not a folder")
    sweep()
    top = _top(real_cwd)
    real = top or real_cwd
    if real.parent == real:
        raise ScratchRefused(f"{real} is a drive root")
    home = ROOT / f"{time.strftime('%m%d%H%M')}-{uuid.uuid4().hex[:6]}"
    home.mkdir(parents=True)
    scr = Scratch(real, home / real.name, real_cwd.relative_to(real).as_posix())
    try:
        scr._mark()
        if top is not None:
            scr._worktree(top, scr.base)
            return scr
        fits, nrepos, _, _ = _fits(real, COPY_MAX_FILES, COPY_MAX_BYTES)
        unit = Unit(real, scr.base, git=False)
        scr.units.append(unit)
        repos: list[tuple[Path, Path]] = []
        if fits and nrepos <= REPOS_MAX:
            scr._plain(real, scr.base, unit, repos)
        else:
            scr.base.mkdir(parents=True)
            budget = [COPY_MAX_FILES, COPY_MAX_BYTES]
            for entry in sorted(real.iterdir()):
                if _skipped(entry) and entry.is_dir():
                    scr.references.add(entry.name.casefold())
                elif entry.is_file():
                    if entry.stat().st_size <= FILE_MAX_BYTES:
                        unit.base[entry.name] = _copy_file(entry, scr.base / entry.name)
                elif _checkout(entry):
                    repos.append((entry, scr.base / entry.name))
                elif entry.is_dir():
                    ok, inner, n, b = (False, 0, 0, 0) if entry.name.startswith(".") else _fits(
                        entry, min(DIR_MAX_FILES, budget[0]), min(DIR_MAX_BYTES, budget[1]))
                    if ok and len(repos) + inner <= REPOS_MAX:
                        scr._plain(entry, scr.base / entry.name, unit, repos)
                        budget[0], budget[1] = budget[0] - n, budget[1] - b
                    else:
                        scr.references.add(entry.name.casefold())
        for repo, copy in repos[:REPOS_MAX]:
            try:
                scr._worktree(repo, copy)
            except ScratchRefused:
                scr.references.add(repo.relative_to(real).parts[0].casefold())  # an empty checkout: left out
        for repo, _ in repos[REPOS_MAX:]:
            scr.references.add(repo.relative_to(real).parts[0].casefold())
        return scr
    except BaseException:
        scr.drop()
        raise


def sweep(now: float | None = None) -> int:
    """Remove the copies a process that is gone left behind (older than STALE_S): their worktrees, then their folders."""
    now = now or time.time()
    removed = 0
    if not ROOT.is_dir():
        return 0
    for home in ROOT.iterdir():
        try:
            mark = json.loads((home / MARK).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            mark = {}
        made = float(mark.get("made") or (home.stat().st_mtime if home.exists() else now))
        if now - made < STALE_S or (mark.get("pid") == os.getpid()):
            continue
        for repo, copy in mark.get("worktrees") or []:
            _unregister(Path(repo), Path(copy))
        _rmtree(home)
        removed += 1
    return removed


def refused_recently(cwd: str) -> bool:
    """Whether no copy could be made of this folder in the last REFUSED_S (free_route.eligible skips it meanwhile)."""
    hit = _REFUSED.get(os.path.normcase(str(cwd)))
    return bool(hit) and time.monotonic() - hit[0] < REFUSED_S


def note_refused(cwd: str, why: str) -> None:
    _REFUSED[os.path.normcase(str(cwd))] = (time.monotonic(), why)
