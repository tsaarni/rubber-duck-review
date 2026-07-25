## Development

Press `F5` in VS Code to launch a debug window with the extension loaded.

| Command | Description |
|---|---|
| `pnpm run compile` | Compile TypeScript. |
| `pnpm run watch` | Compile and watch for changes. |
| `pnpm run package` | Package the extension into `rubber-duck-review.vsix`. |
| `pnpm run install-extension` | Compile, package, and install the extension into VS Code. |
| `pnpm run check` | Check for lint and format issues using Biome. |
| `pnpm run format` | Auto-fix lint and format issues using Biome. |

## Releasing

To release a new version of the extension:

1. **Bump Version & Tag**:
   ```bash
   pnpm version <patch|minor|major|x.y.z>
   ```
   *Bumps `"version"` in `package.json`, creates a git commit, and tags the release.*

2. **Push Commit & Tag**:
   ```bash
   git push --follow-tags
   ```
   *Pushes both the commit and the newly created tag to GitHub.*

Pushing the tag triggers the GitHub Actions release workflow, which compiles, packages the `.vsix` artifact, and publishes a new GitHub Release with the attached `.vsix` file.

