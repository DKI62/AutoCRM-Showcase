export function sanitizeSystemPath(path: string): string {
  if (path.length > 4096) return '/';
  try {
    // Reject malformed encodings before Router's transitive query-string decoder.
    decodeURI(path);
    return path;
  } catch { return '/'; }
}
