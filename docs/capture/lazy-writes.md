# Lazy writes and the bounded install session (Phase 8)

This document records the Phase 8 lazy-write workflow and the bounded install session that replaces
the implicit `--help` first run. It implements decision **D5** in the `docs/capture/plan.md` Decisions log
and removes the pre-rewrite behavior described in plan section 5.

The plan's rule is: **do not silently run arbitrary installed tools as the only way to discover their
writes.** Before Phase 8, `tret install` ran the freshly installed executable once with `--help` and
took another snapshot, so lazy initialization would land in the record. That is gone.

## What changed

- `src/lib/first-run.ts` (which spawned the installed tool with `--help`) is **removed**. The install
  never runs an installed tool on the user's behalf; the only command that runs a tracked tool is
  `tret trace`, and it asks first.
- `tret install` runs the installer inside a **bounded capture session**
  (`src/lib/session.ts`) and reports the observation window and its coverage. The installer runs
  exactly once; there is no second invocation of the installed tool.
- The record shape already reserves **per-segment captures** (`CaptureSegment` in `src/types.ts`),
  added in Phase 3. That reservation is why `tret trace` shipped without a record format
  migration: the command appends a `{ kind: "trace" }` segment to `capture.segments` instead of
  changing the record shape.
- `src/lib/platform/roots.ts` expands the platform table into bounded observation roots (D3), and
  `installObservationRoots` drops shared cache directories (the one narrow skip carried over from the
  legacy snapshot).
- `src/lib/capture/current.ts` selects the platform's backend: the Linux tracer or the macOS labeled
  heuristic fallback (D1/D7).

## The bounded install session

`runBoundedSession` (`src/lib/session.ts`) wraps exactly one observation window:

```ts
const session = await runBoundedSession({
  backend: captureBackendFor(platform), // Linux tracer or macOS heuristic fallback
  pid: process.pid, // the installer runs as a child, so this pid covers it
  privilege: platform.privilege.defaultPrivilege, // "user"; Tret never escalates (D8)
  roots: installObservationRoots(platform), // bounded D3 scope
  run: () => runInstaller(script, scriptArgs), // runs once, inside the window
});
```

It returns the work's value (or error), the backend's `Journal`, and a `SessionCoverage` that carries
the backend name, completeness, partial reason, event count, roots, and a record-shaped
`CaptureSegment`:

```ts
{
  backend: "macos-heuristic",
  completeness: "heuristic",
  partialReason: "3 roots could not be read",
  segment: {
    kind: "install",
    startedAt: "2026-10-09T12:00:00.000Z",
    endedAt: "2026-10-09T12:00:03.500Z",
    partialReason: "3 roots could not be read",
  },
  events: 42,
  roots: ["/opt/homebrew/bin", "/usr/local/bin", "…"],
}
```

`tret install` prints one line reporting it:

```
observed the install with macos-heuristic: heuristic attribution, no process tree: 3 roots could not be read; window 2026-10-09T12:00:00.000Z → 2026-10-09T12:00:03.500Z (3.5s); 42 events over 14 roots
```

`--no-capture` skips attaching a backend entirely; the installer still runs and the CLI says no window
was recorded. Capture is **best-effort but never silent**: if the platform tracer cannot attach
before the work starts, `install` and `trace` try the labeled heuristic backend (`linux-heuristic` on
Linux, `macos-heuristic` on macOS); an install whose fallback also cannot start still runs once
through the legacy snapshot/diff path. The observed work runs at most once either way.

### Boundary guarantees

The session owns the window edges, and the tests in `src/lib/session.test.ts` pin them:

| Boundary                                     | Behavior                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Capture must cover the work                  | The backend is started **before** `run`, so the work is inside the observed tree and no window is claimed it lacks. |
| A backend that cannot attach                 | `start` throws before `run`, so the work never executes unwatched; the caller decides whether to proceed.           |
| The observed work throws                     | `stop` still runs, so a tracer is never leaked; the work's error is returned and capture is closed.                 |
| The backend fails to close                   | Reported as `completeness: "partial"` with a `partialReason`, not thrown — the install is never re-run.             |
| Incomplete capture reported without a reason | The segment still carries a default `partialReason`, so a record never reads as complete by omission.               |

## Coverage labels

Completeness is never assumed. It comes from the journal the backend produced:

- **`complete`** — a tracer observed the whole process tree to its natural exit.
- **`partial`** — a tracer attached but lost coverage (a uid transition, a daemonized descendant still
  alive at close, an unsupported syscall). `partialReason` names the blind spot.
- **`heuristic`** — no process attribution at all; the macOS scoped-snapshot fallback. Changes are
  inferred, not attributed (D1).

`tret install` uses the running platform's backend, so a record's `capture.backend` distinguishes a
Linux tracer from the macOS fallback. The session reports the label at install time; Phase 9 surfaces
it in `tret list` and uninstall output.

## `tret trace` (D5, shipped)

D5 deferred the command until install-time capture was trustworthy; the reserved record segment is
what let it land without a migration. The command now ships in `src/commands/trace.ts`.

`tret trace <tool>` resolves its selector the way every other command does (`selectRecord` in
`src/lib/record-selection.ts`): a display name that matches exactly one record, or a record id. A
name shared by several records fails and lists the ids. `--yes` skips the confirmation prompt, and
`--json` emits the machine-readable form instead of the human lines.

Tracing is explicit and opt-in. On an interactive terminal the command asks
`run <executable> in an observation window? [y/N]` before it runs anything, and aborts with nothing
traced when the answer is no. Without a terminal, or in JSON mode, it refuses with exit code `5`
unless `--yes` is passed, so it never runs a tool without either an answer or explicit consent. It
never runs a tool silently, and a record with no tracked executable is refused rather than run.

The tool runs inside a bounded observation window through the same platform backend `tret install`
uses (`captureBackendFor`), over the same bounded install roots (`installObservationRoots`). If that
backend cannot attach, the command fails and the tool is never run unwatched. The command reports
the window and its coverage the way install does — the backend, the `complete`/`partial`/`heuristic`
label, and the start → end window — and it reports what it could not cover instead of claiming
completeness: a backend that lost the process tree or saw unsupported syscalls lowers the window to
`partial` with a `partialReason` on the segment, and the normalization diagnostics (including the
`coverage` one) are printed and included in `--json`. The record's own `capture.backend` and
`capture.completeness` stay the install's values; the trace window's coverage is carried by its own
segment.

The window's journal is normalized with the same converter the install uses (`normalizeJournal` in
`src/lib/journal/normalize.ts`) and the effects are **appended** to the existing record: new owned,
mutated, and deleted paths are added to `owned`, `mutated`, and `deleted`, and a
`{ kind: "trace", … }` segment is appended to `capture.segments`. No record format migration was
needed, because Phase 3 reserved the segment.

Ownership is never taken away:

- A path the record already tracks — as owned, mutated, or deleted — is left as it is. The
  install's original evidence is more specific than a later trace, so the path is skipped and
  reported as `already-tracked`.
- A path another record claims is skipped and reported as `claimed-by-other`, never added. The
  check is the same case-correct ownership check uninstall planning uses (`claimedByOthers` and
  `sharedClaim` in `src/lib/uninstall-planner.ts`), so a trace can never take a path away from
  another tool (D4).

Lazy writes are still not captured automatically: nothing runs an installed tool behind the user's
back. A record describes what the install window changed, and a later run is recorded by running
the tool through `tret trace <tool>`. For a tool Tret never installed, `tret find` still adopts the
files it finds on disk.

## What is intentionally not done here

- The `tret trace` command is implemented: it runs a tracked tool inside a bounded observation
  window and appends what the tool wrote to the record, after the user consents.
- No live re-attachment after the install window closes. A trace opens a new bounded window rather
  than re-attaching to the closed one, and daemonized or detached descendants are reported as
  `partial`, never as `complete`.
- The install never invokes the installed tool, with or without `--help`. The only invocation is
  `tret trace`, which runs the tracked executable with no arguments, and only after the user asks
  for it.
