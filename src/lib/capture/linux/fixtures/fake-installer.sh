#!/bin/sh
# Fake install script for the Linux capture backend integration fixture.
#
# It performs a small, deterministic "install" under $TRET_FIXTURE_HOME and $TRET_FIXTURE_TMPDIR and
# writes a matching strace trace to stdout. The fake `strace` double (fake-strace.sh) redirects that
# stdout to the file the real StraceTracer would read, so the full
# LinuxCaptureBackend -> reconstruction -> normalizeJournal path runs hermetically on any host, with
# no real Linux ptrace tracer required.
#
# Only syscalls that really happened are emitted: `mkdir` is emitted only when the directory was
# actually created, matching what a process-tree tracer reports.
set -eu

H="${TRET_FIXTURE_HOME:?TRET_FIXTURE_HOME is required}"
T="${TRET_FIXTURE_TMPDIR:?TRET_FIXTURE_TMPDIR is required}"
PID="${TRET_FIXTURE_PID:-1000}"
T0="${TRET_FIXTURE_TIME:-1700000000}"
N=0

emit() {
  N=$((N + 1))
  printf '%s  %s.%06d %s\n' "$PID" "$T0" "$N" "$1"
}

# `.mytool` is seeded by the test before the window, so it is not created here.
mkdir -p "$H/.mytool/bin"
emit "mkdir(\"$H/.mytool/bin\", 0755) = 0"

# Stage the executable in TMPDIR, then rename it into place (temp-file + cross-directory rename).
printf '#!/bin/sh\necho tool\n' > "$T/stage.tool"
emit "openat(AT_FDCWD, \"$T/stage.tool\", O_WRONLY|O_CREAT|O_TRUNC, 0755) = 3</$T/stage.tool>"
emit "write(3</$T/stage.tool>, \"#!/bin/sh\\n\", 10) = 10"
mv "$T/stage.tool" "$H/.mytool/bin/tool"
emit "rename(\"$T/stage.tool\", \"$H/.mytool/bin/tool\") = 0"

chmod 0755 "$H/.mytool/bin/tool"
emit "chmod(\"$H/.mytool/bin/tool\", 0755) = 0"

if [ ! -d "$H/.local" ]; then
  mkdir "$H/.local"
  emit "mkdir(\"$H/.local\", 0755) = 0"
fi
mkdir -p "$H/.local/bin"
emit "mkdir(\"$H/.local/bin\", 0755) = 0"
ln -s "$H/.mytool/bin/tool" "$H/.local/bin/tool"
emit "symlink(\"$H/.mytool/bin/tool\", \"$H/.local/bin/tool\") = 0"

# Overwrite a config file that already existed before the window (a mutation, not ownership).
printf 'version=2\n' > "$H/.mytool/config"
emit "openat(AT_FDCWD, \"$H/.mytool/config\", O_WRONLY|O_CREAT|O_TRUNC, 0644) = 4</$H/.mytool/config>"
emit "write(4</$H/.mytool/config>, \"version=2\\n\", 10) = 10"

# Remove a file that already existed before the window (a deletion).
rm -f "$H/.mytool/old"
emit "unlink(\"$H/.mytool/old\") = 0"

# Create and then remove a scratch file and a cache directory (these must cancel out).
: > "$H/.mytool/scratch"
emit "openat(AT_FDCWD, \"$H/.mytool/scratch\", O_WRONLY|O_CREAT, 0644) = 5</$H/.mytool/scratch>"
rm -f "$H/.mytool/scratch"
emit "unlink(\"$H/.mytool/scratch\") = 0"
mkdir "$H/.mytool/cache"
emit "mkdir(\"$H/.mytool/cache\", 0700) = 0"
rmdir "$H/.mytool/cache"
emit "rmdir(\"$H/.mytool/cache\") = 0"

# Unrelated churn outside the observe roots: the tracer reports it (so the backend's scope filter is
# actually exercised), but it must not be attributed to the install. This also marks completion.
if [ -n "${TRET_FIXTURE_MARKER:-}" ]; then
  : > "$TRET_FIXTURE_MARKER"
  emit "openat(AT_FDCWD, \"$TRET_FIXTURE_MARKER\", O_WRONLY|O_CREAT|O_TRUNC, 0644) = 9</$TRET_FIXTURE_MARKER>"
  emit "write(9</$TRET_FIXTURE_MARKER>, \"x\", 1) = 1"
fi
