/** Content identifies a reader; an existing release keeps its original source. */
export function releasePlan(readerSha256, commit, taggedCommit = null) {
  if (!/^[0-9a-f]{64}$/.test(readerSha256) || readerSha256.length !== 64)
    throw new Error("Choose the full lowercase SHA-256 of the reader.");
  for (const value of [
    commit,
    ...(taggedCommit === null ? [] : [taggedCommit]),
  ])
    if (!/^[0-9a-f]{40}$/.test(value) || value.length !== 40)
      throw new Error("Invalid source commit.");
  return {
    tag: `sha256-${readerSha256}`,
    sourceCommit: taggedCommit ?? commit,
  };
}

/** Select prose from the changelog's controlled level-two release headings. */
export function releaseNotes(changelog, tag) {
  const entries = changelog
    .replace(/\r\n?/g, "\n")
    .split(/^##(?:[ \t]+|$)/m)
    .slice(1)
    .map((section) => {
      const [heading, ...body] = section.split("\n");
      const match =
        /^\[([^\]]+)\]\(https:\/\/github\.com\/qecez\/paperwarden\/releases\/tag\/(sha256-[0-9a-f]{64})\)$/.exec(
          heading,
        );
      return {
        title: match?.[1],
        tag: match?.[2],
        body: body.join("\n").trim(),
      };
    })
    .filter((entry) => entry.tag === tag);
  if (entries.length !== 1 || !entries[0].body)
    throw new Error(
      `Add exactly one nonempty CHANGELOG.md entry linked to ${tag}.`,
    );
  return `## ${entries[0].title}\n\n${entries[0].body}`;
}
