const { execFileSync } = require("node:child_process");

const committer = execFileSync("git", ["var", "GIT_COMMITTER_IDENT"], {
  encoding: "utf8"
}).trim().replace(/>.*$/, ">");

module.exports = {
  branches: ["main"],
  plugins: [
    ["@semantic-release/commit-analyzer", {
      preset: "conventionalcommits",
      releaseRules: [
        { breaking: true, release: "major" },
        { type: "refactor", release: "patch" },
        { type: "feat", release: "minor" },
        { type: "fix", release: "patch" },
        { type: "perf", release: "patch" },
        { type: "revert", release: "patch" },
        { type: "docs", release: false },
        { type: "style", release: false },
        { type: "test", release: false },
        { type: "build", release: false },
        { type: "ci", release: false },
        { type: "chore", release: false },
      ],
    }],
    ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
    ["@semantic-release/npm", { npmPublish: false }],
    ["@semantic-release/changelog", {}],
    ["@semantic-release/git", {
      assets: ["CHANGELOG.md", "package.json", "package-lock.json"],
      message: "chore(release): ${nextRelease.version}\n\n${nextRelease.notes}\n\nSigned-off-by: " + committer,
    }],
    ["@semantic-release/github", {}],
  ],
};
