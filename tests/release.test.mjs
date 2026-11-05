import { expect, test } from "vitest";
import { releaseNotes, releasePlan } from "../scripts/release-plan.mjs";
const commit = "a".repeat(40);
const digest = "b".repeat(64);
test("uses the final reader checksum as its complete release identity", () => {
  expect(releasePlan(digest, commit)).toEqual({
    tag: `sha256-${digest}`,
    sourceCommit: commit,
  });
  expect(releasePlan(digest, commit, commit)).toEqual(
    releasePlan(digest, commit),
  );
});
test("retains the original source when unchanged reader bytes recur", () => {
  const original = "c".repeat(40);
  expect(releasePlan(digest, commit, original)).toEqual({
    tag: `sha256-${digest}`,
    sourceCommit: original,
  });
});
test("rejects abbreviated, noncanonical, or ambiguous identities", () => {
  for (const hash of [
    "abc123",
    digest.toUpperCase(),
    digest + "\n",
    "g".repeat(64),
    `sha256-${digest}`,
  ])
    expect(() => releasePlan(hash, commit)).toThrow();
  for (const source of [
    "abc1234",
    commit + "\n",
    commit.toUpperCase(),
    "g".repeat(40),
  ]) {
    expect(() => releasePlan(digest, source)).toThrow();
    expect(() => releasePlan(digest, commit, source)).toThrow();
  }
});

test("selects the matching release prose without neighboring entries or level-two headings", () => {
  const tag = `sha256-${digest}`;
  const heading = (label, value) =>
    `## [${label}](https://github.com/qecez/paperwarden/releases/tag/${value})`;
  const prose =
    "Two clear paragraphs.\n\n### Recovery\n\n- Keep the saved app.";
  const changelog = [
    "# Change log",
    "Introductory text.",
    heading("Another release", `sha256-${"c".repeat(64)}`),
    "Different reader.",
    heading("Initial release", tag),
    "",
    prose,
    "",
    "## Maintenance notes",
    "Not part of the release.",
  ].join("\r\n");
  expect(releaseNotes(changelog, tag)).toBe(`## Initial release\n\n${prose}`);
});
