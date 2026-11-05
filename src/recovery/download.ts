/** Explicit user-initiated download. Never serializes the current form. */
export function download(
  data: string | Uint8Array,
  type: string,
  name: string,
): void {
  const url = URL.createObjectURL(
    new Blob([typeof data === "string" ? data : new Uint8Array(data)], {
      type,
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Allow mobile PDF viewers time to consume the download before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
