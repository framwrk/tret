/*
 * tret-fanotify: privileged fanotify capture helper for Tret's Linux backend.
 *
 * The TypeScript `FanotifyTracer` spawns this program as
 *
 *     tret-fanotify --pid <installer-pid> --root <absolute-root> [--root ...]
 *
 * and reads newline-delimited `TracerRecord` JSON from stdout, plus `@loss <reason>` control lines
 * from stderr. It is the high-fidelity alternative to the unprivileged strace tracer and is only
 * viable when the caller already holds CAP_SYS_ADMIN (root): fanotify PID reporting and
 * `open_by_handle_at` path resolution require that privilege. Tret never escalates to acquire it.
 *
 * Build (packaging time; the helper is not compiled by `bun test`):
 *
 *     cc -O2 -o tret-fanotify tret-fanotify.c
 *
 * Why a helper: Bun cannot issue fanotify syscalls directly, and fanotify needs a C-level event loop
 * over `read(2)`. The helper does the kernel decoding and emits the same event shape the strace
 * parser produces, so the backend, reconstruction and normalization are shared (plan section 8).
 *
 * Coverage notes (also documented in docs/capture/linux-capture.md):
 * - The mark is FAN_MARK_FILESYSTEM, not FAN_MARK_MOUNT. FAN_CREATE/FAN_DELETE/FAN_MOVED_* require
 *   a filesystem mark; the kernel rejects them with EINVAL on a mount mark.
 * - The group is initialized with FAN_REPORT_FID | FAN_REPORT_DFID_NAME. Directory-entry events
 *   then carry the modified directory's FID plus the entry name, and the path is reconstructed as
 *   parent + name. Without FAN_REPORT_DFID_NAME the kernel reports only the parent directory, so
 *   create/delete/move would be attributed to the wrong object.
 * - Move pairing matches FAN_MOVED_FROM/FAN_MOVED_TO FIFO within a read buffer, since fanotify does
 *   not expose a rename cookie; an unmatched move degrades to an unlink/create pair.
 * - A deleted node cannot be stat(2)ed, so FAN_DELETE is reported as an `unlink`; directory removal
 *   is inferred from FAN_DELETE_SELF context only where the kernel provides it.
 * - FAN_ONDIR is not requested, so events on directory objects themselves (mkdir/rmdir) are not
 *   reported. That remains the documented F2 fidelity gap; file events are unaffected.
 * - FAN_Q_OVERFLOW reports `@loss` so the backend marks the record partial instead of claiming
 *   completeness.
 * - Memory-mapped writes and network filesystems are not observable; the TS coverage doc lists this.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fanotify.h>
#include <linux/limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/fanotify.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define MAX_ROOTS 64
#define MAX_PENDING_MOVES 256

struct pending_move {
  char from[PATH_MAX];
};

static int root_fds[MAX_ROOTS];
static int root_count = 0;
static int install_pid = -1;
static struct pending_move moves[MAX_PENDING_MOVES];
static int move_count = 0;

static long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  return (long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void emit_loss(const char *reason) {
  fprintf(stderr, "@loss %s\n", reason);
  fflush(stderr);
}

/* JSON string escaping for the paths and targets we emit. */
static void print_json_string(const char *value) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    switch (*p) {
      case '"': fputs("\\\"", stdout); break;
      case '\\': fputs("\\\\", stdout); break;
      case '\n': fputs("\\n", stdout); break;
      case '\t': fputs("\\t", stdout); break;
      case '\r': fputs("\\r", stdout); break;
      default:
        if (*p < 0x20) printf("\\u%04x", *p);
        else putchar(*p);
    }
  }
  putchar('"');
}

/* Resolves a fanotify file handle to an absolute path via open_by_handle_at + /proc/self/fd. */
static int resolve_handle(const struct file_handle *handle, char *out, size_t out_len) {
  for (int i = 0; i < root_count; i++) {
    int fd = open_by_handle_at(root_fds[i], (struct file_handle *)handle, O_PATH | O_RDONLY);
    if (fd < 0) continue;
    char link[64];
    snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
    ssize_t n = readlink(link, out, out_len - 1);
    close(fd);
    if (n < 0) return -1;
    /* A full buffer may mean the kernel truncated the path; never emit a partial path. */
    if ((size_t)n >= out_len - 1) return -1;
    out[n] = '\0';
    return 0;
  }
  return -1;
}

static struct file_handle *fid_handle(const struct fanotify_event_info_fid *fid) {
  return (struct file_handle *)fid->handle;
}

/*
 * Extracts the parent directory handle and entry name from a FAN_EVENT_INFO_TYPE_DFID_NAME record.
 * The name follows the file handle and is NUL-terminated, but the record is padded to 4 bytes, so
 * bound it by the record end. Returns the name length, or -1 when the record is malformed.
 */
static int dfid_name(const struct fanotify_event_info_fid *fid, struct file_handle **parent, const char **name) {
  const struct fanotify_event_info_header *hdr = &fid->hdr;
  size_t header_len = sizeof(struct fanotify_event_info_fid) + sizeof(struct file_handle);
  if (hdr->len < header_len) return -1;
  struct file_handle *handle = fid_handle(fid);
  size_t fh_len = handle->handle_bytes;
  if (fh_len > hdr->len - header_len) return -1;
  const char *entry = (const char *)fid->handle + sizeof(struct file_handle) + fh_len;
  const char *end = (const char *)hdr + hdr->len;
  size_t max = (size_t)(end - entry);
  size_t len = strnlen(entry, max);
  if (len == 0 || len == max) return -1;
  *parent = handle;
  *name = entry;
  return (int)len;
}

/* Joins a resolved directory path and a single dirent name. "." means the directory itself. */
static int entry_path(char *out, size_t out_len, const char *dir, const char *name, size_t name_len) {
  if (name_len == 1 && name[0] == '.') {
    size_t len = strlen(dir);
    if (len + 1 > out_len) return -1;
    memcpy(out, dir, len + 1);
    return 0;
  }
  for (size_t i = 0; i < name_len; i++) {
    if (name[i] == '/' || name[i] == '\0') return -1;
  }
  if (name_len == 2 && name[0] == '.' && name[1] == '.') return -1;
  size_t dir_len = strlen(dir);
  int needs_slash = dir_len > 0 && dir[dir_len - 1] != '/';
  size_t total = dir_len + (size_t)needs_slash + name_len + 1;
  if (total > out_len) return -1;
  memcpy(out, dir, dir_len);
  size_t pos = dir_len;
  if (needs_slash) out[pos++] = '/';
  memcpy(out + pos, name, name_len);
  out[pos + name_len] = '\0';
  return 0;
}

/* True when `pid` appears in the descendant tree of the installer (best effort via /proc). */
static int is_descendant(int pid) {
  if (install_pid < 0) return 1;
  if (pid == install_pid) return 1;
  int current = pid;
  for (int depth = 0; depth < 64 && current > 1; depth++) {
    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/stat", current);
    FILE *f = fopen(path, "r");
    if (!f) return 0;
    int ppid = 0;
    /* /proc/<pid>/stat: pid (comm) state ppid ... ; comm may contain spaces, so skip past ')'. */
    char buf[4096];
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[n] = '\0';
    char *close_paren = strrchr(buf, ')');
    if (!close_paren) return 0;
    if (sscanf(close_paren + 2, "%*c %d", &ppid) != 1) return 0;
    if (ppid == install_pid) return 1;
    current = ppid;
  }
  return 0;
}

static void emit_event(const char *op, const char *path, int pid, int is_dir) {
  printf("{\"op\":\"%s\",\"at\":%ld,\"pid\":%d,", op, now_ms(), pid);
  if (strcmp(op, "mkdir") == 0) {
    printf("\"path\":"); print_json_string(path); printf("}");
  } else if (strcmp(op, "open") == 0) {
    printf("\"path\":"); print_json_string(path);
    printf(",\"created\":%s,\"truncated\":false}", is_dir ? "false" : "true");
  } else {
    printf("\"path\":"); print_json_string(path); printf("}");
  }
  putchar('\n');
  fflush(stdout);
}

static void emit_rename(const char *from, const char *to, int pid) {
  printf("{\"op\":\"rename\",\"at\":%ld,\"pid\":%d,\"from\":", now_ms(), pid);
  print_json_string(from);
  printf(",\"to\":");
  print_json_string(to);
  printf("}\n");
  fflush(stdout);
}

static void emit_write(const char *path, int pid) {
  printf("{\"op\":\"write\",\"at\":%ld,\"pid\":%d,\"path\":", now_ms(), pid);
  print_json_string(path);
  printf("}\n");
  fflush(stdout);
}

static void emit_chmod(const char *path, int pid) {
  struct stat st;
  if (stat(path, &st) != 0) return;
  printf("{\"op\":\"chmod\",\"at\":%ld,\"pid\":%d,\"path\":", now_ms(), pid);
  print_json_string(path);
  printf(",\"mode\":%o}\n", (unsigned)(st.st_mode & 07777));
  fflush(stdout);
}

static void remember_move(const char *from) {
  if (move_count >= MAX_PENDING_MOVES) {
    emit_loss("move-pair table overflowed; a rename may be split into unlink+create");
    move_count = 0;
  }
  snprintf(moves[move_count].from, PATH_MAX, "%s", from);
  move_count++;
}

/* Fanotify does not expose a rename cookie, so the most recent MOVED_FROM is paired FIFO. */
static int take_move(char *from_out) {
  if (move_count == 0) return 0;
  snprintf(from_out, PATH_MAX, "%s", moves[0].from);
  for (int i = 1; i < move_count; i++) moves[i - 1] = moves[i];
  move_count--;
  return 1;
}

static void handle_event(const struct fanotify_event_metadata *meta) {
  if (meta->event_len < meta->metadata_len) return;
  if (!is_descendant((int)meta->pid)) return;

  /*
   * With FAN_REPORT_FID | FAN_REPORT_DFID_NAME, a file event carries both the object FID and a
   * parent-FID-plus-name record, while a directory-entry event carries only the latter (unless
   * FAN_REPORT_TARGET_FID is requested). Collect both shapes and choose per event type.
   */
  const struct fanotify_event_info_fid *object_fid = NULL;
  const struct fanotify_event_info_fid *name_fid = NULL;
  const struct fanotify_event_info_header *hdr;
  const char *ptr = (const char *)meta + meta->metadata_len;
  const char *end = (const char *)meta + meta->event_len;
  for (; ptr + sizeof(*hdr) <= end; ptr += hdr->len) {
    hdr = (const struct fanotify_event_info_header *)ptr;
    if (hdr->len < sizeof(*hdr)) break;
    if ((const char *)hdr + hdr->len > end) break;
    if (hdr->info_type == FAN_EVENT_INFO_TYPE_FID) {
      object_fid = (const struct fanotify_event_info_fid *)ptr;
    } else if (hdr->info_type == FAN_EVENT_INFO_TYPE_DFID_NAME) {
      name_fid = (const struct fanotify_event_info_fid *)ptr;
    }
  }

  uint64_t mask = meta->mask;
  int pid = (int)meta->pid;
  int is_dirent = (mask & (FAN_CREATE | FAN_DELETE | FAN_MOVED_FROM | FAN_MOVED_TO)) != 0;

  char path[PATH_MAX];
  if (is_dirent || object_fid == NULL) {
    struct file_handle *parent = NULL;
    const char *name = NULL;
    int name_len = name_fid == NULL ? -1 : dfid_name(name_fid, &parent, &name);
    if (name_len < 0) {
      emit_loss(is_dirent ? "a directory-entry event did not include a parent handle and name"
                          : "a fanotify event did not include a resolvable file handle");
      return;
    }
    char parent_path[PATH_MAX];
    if (resolve_handle(parent, parent_path, sizeof(parent_path)) != 0) {
      emit_loss("could not resolve a fanotify file handle to a path");
      return;
    }
    if (entry_path(path, sizeof(path), parent_path, name, (size_t)name_len) != 0) {
      emit_loss("a fanotify directory entry name could not be joined to its parent path");
      return;
    }
  } else if (resolve_handle(fid_handle(object_fid), path, sizeof(path)) != 0) {
    emit_loss("could not resolve a fanotify file handle to a path");
    return;
  }

  if (mask & FAN_MOVED_FROM) {
    remember_move(path);
    return;
  }
  if (mask & FAN_MOVED_TO) {
    char from[PATH_MAX];
    if (take_move(from)) emit_rename(from, path, pid);
    else emit_event("open", path, pid, 0);
    return;
  }
  if (mask & FAN_CREATE) {
    struct stat st;
    int is_dir = stat(path, &st) == 0 && S_ISDIR(st.st_mode);
    emit_event(is_dir ? "mkdir" : "open", path, pid, is_dir);
    return;
  }
  if (mask & FAN_DELETE) {
    emit_event("unlink", path, pid, 0);
    return;
  }
  if (mask & FAN_MODIFY) {
    emit_write(path, pid);
    return;
  }
  if (mask & FAN_ATTRIB) {
    emit_chmod(path, pid);
    return;
  }
  if (mask & FAN_CLOSE_WRITE) {
    emit_write(path, pid);
  }
}

int main(int argc, char **argv) {
  uint64_t mask = FAN_CREATE | FAN_DELETE | FAN_MOVED_FROM | FAN_MOVED_TO | FAN_MODIFY | FAN_ATTRIB | FAN_CLOSE_WRITE;
  const char *roots[MAX_ROOTS];
  int root_paths = 0;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--pid") == 0 && i + 1 < argc) {
      install_pid = atoi(argv[++i]);
    } else if (strcmp(argv[i], "--root") == 0 && i + 1 < argc && root_paths < MAX_ROOTS) {
      roots[root_paths++] = argv[++i];
    }
  }
  if (root_paths == 0) {
    emit_loss("no --root given to tret-fanotify");
    return 2;
  }

  int fd = fanotify_init(FAN_CLASS_NOTIF | FAN_REPORT_FID | FAN_REPORT_DFID_NAME, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    emit_loss("fanotify_init failed; fanotify with FAN_REPORT_DFID_NAME requires Linux 5.9+ and CAP_SYS_ADMIN");
    return 1;
  }

  for (int i = 0; i < root_paths; i++) {
    int root_fd = open(roots[i], O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (root_fd < 0) {
      emit_loss("could not open an observe root");
      continue;
    }
    if (fanotify_mark(fd, FAN_MARK_ADD | FAN_MARK_FILESYSTEM, mask, root_fd, NULL) != 0) {
      char reason[512];
      snprintf(reason, sizeof(reason), "fanotify_mark failed on %s: %s", roots[i], strerror(errno));
      emit_loss(reason);
      close(root_fd);
      continue;
    }
    root_fds[root_count++] = root_fd;
  }

  char buffer[8192];
  for (;;) {
    ssize_t len = read(fd, buffer, sizeof(buffer));
    if (len < 0) {
      if (errno == EINTR) continue;
      emit_loss("fanotify read failed");
      break;
    }
    if (len == 0) break;
    struct fanotify_event_metadata *meta = (struct fanotify_event_metadata *)buffer;
    for (; FAN_EVENT_OK(meta, len); meta = FAN_EVENT_NEXT(meta, len)) {
      if (meta->mask & FAN_Q_OVERFLOW) {
        emit_loss("fanotify queue overflowed; events were dropped");
        continue;
      }
      handle_event(meta);
    }
  }

  for (int i = 0; i < root_count; i++) close(root_fds[i]);
  close(fd);
  return 0;
}
