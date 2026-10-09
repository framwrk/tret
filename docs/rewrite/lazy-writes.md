# Lazy writes and the bounded install session (Phase 8)

This document records the Phase 8 lazy-write workflow and the bounded install session that replaces
the implicit `--help` first run. It implements decision **D5** in the `REWRITE_PLAN.md` Decisions log
and removes the pre-rewrite behavior described in plan section 5.

The plan's rule is: **do not silently run arbitrary installed tools as the only way to discover their
writes.** Before Phase 8, `tret install` ran the freshly installed executable once with `--help` and
took another snapshot, so lazy initialization would land in the record. That is gone.

## What changed

- `src/lib/first-run.ts` (which spawned the installed tool with `--help`) is **removed**. Nothing runs
  an installed tool on the user's behalf any more.
- `tret install` runs the installer inside a **bounded capture session**
  (`src/lib/session.ts`) and reports the observation window and its coverage. The installer runs
  exactly once; there is no second invocation of the installed tool.
- The record shape already reserves **per-segment captures** (`CaptureSegment` in `src/types.ts`),
  added in Phase 3, so a later explicit trace can attach a new segment with no format migration. D5's
  chosen default is "no `trace` command yet"; the reservation is what makes adding one later cheap.
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
was recorded. Capture is **best-effort but never silent**: if a backend cannot attach, the install
proceeds without a window and says so. The installer runs once either way.

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

## Deferred `tret trace` design (D5)

D5 defers the explicit trace command and chooses the bounded install window as the default until
install-time capture is trustworthy. This phase keeps that default and reserves the record segment so
the command can be added without a migration. When it lands it will:

1. Look up the existing record for the named tool (by name, across v3 records).
2. Run the tool under `runBoundedSession` with `kind: "trace"` and the same platform backend, showing
   the same window/coverage output.
3. Normalize the trace journal with the Phase 3 converter and **append** its owned/mutated/deleted
   effects to the record, appending a `{ kind: "trace", … }` segment to `capture.segments`.

`buildCaptureSegment` already accepts `kind: "trace"`, and a v3 record with an `install` segment plus a
`trace` segment validates (`isV3Record`), as the session tests assert. No format change is required:
the only missing pieces are a command entry, a record-merge helper, and the trust in install-time
capture that Phase 5 provides.

Until then, lazy writes are simply **not captured automatically**. A record describes what the
install window changed; if a tool writes files on first run, run the tool yourself and adopt the
changes with `tret find`, or wait for `tret trace`.

## What is intentionally not done here

- No `tret trace` command (D5 defers it).
- No live re-attachment after the install window closes. Daemonized or detached descendants are
  reported as `partial`, never as `complete`.
- No automatic invocation of the installed tool, with or without `--help`.
