# Git commit identity

Before creating or amending commits in this repository, set the local identity:

```sh
git config --local user.name "keepraw"
git config --local user.email "49091395+keepraw@users.noreply.github.com"
git config --local user.useConfigOnly true
```

The managed Codex environment can restore a different global Git identity. Do not
rely on global defaults. Check both `git var GIT_AUTHOR_IDENT` and
`git var GIT_COMMITTER_IDENT` before committing: both must use the exact name and
email above. Remove conflicting `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
`GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, `EMAIL`, or injected Git identity
configuration from the commit process. Do not print tokens or unrelated
environment/configuration values while investigating overrides.

After pushing, verify GitHub's commit API reports both `author.login` and
`committer.login` as `keepraw`. Ordinary commits must never be attributed to
`zzvw`. Official GitHub merges may retain a verified `web-flow` committer.

The `Commit identity` workflow checks every new PR commit using trusted base
branch policy and GitHub API attribution. Identity or API verification failures
must be fixed before merging; do not bypass the check.
