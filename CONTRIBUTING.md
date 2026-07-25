# Contributing

The project provides the following scripts via `pnpm`:

| Command | Description |
|---|---|
| `pnpm run compile` | Compile TypeScript. |
| `pnpm run watch` | Compile and watch for changes. |
| `pnpm run package` | Package the extension into `rubber-duck-review.vsix`. |
| `pnpm run install-extension` | Compile, package, and install the extension into VS Code. |
| `pnpm run check` | Check for lint and format issues using Biome. |
| `pnpm run format` | Auto-fix lint and format issues using Biome. |

## Development

```bash
pnpm install
pnpm run install-extension
```

Then re-launch VS Code to load the extension.

Alternatively, open the project in VS Code and press `F5` to launch a debug window with the extension.

## Releasing

To release a new version of the extension:

1. **Bump Version & Tag**:
   ```bash
   pnpm version <patch|minor|major|x.y.z>
   ```
   This bumps `"version"` in `package.json`, creates a git commit, and tags the release.

2. **Push Commit & Tag**:
   ```bash
   git push --follow-tags
   ```
   This pushes both the commit and the newly created tag to GitHub.

Pushing the tag triggers a GitHub Actions release workflow that compiles the extension, packages it into a `.vsix` artifact, and publishes a new GitHub Release with the attached file.
