# Rubber Duck Review

A VS Code extension for local code reviews. Write inline comments on your source files, stored as JSON in your workspace, see [`reviews-schema.json`](./reviews-schema.json).

The extension supports line and file-level comments and Markdown export that can be given to an LLM agent as input.

## Usage

Run **Rubber Duck: Start Review** from the Command Palette, or click "Start Review" in the status bar.

Once active, `+` icons appear in the editor gutter. Click to add a comment. Drag across lines to comment on a range. Click the `+` at the top of a file for a file-level comment.
Run **Rubber Duck: Add Suggestion** to insert a pre-filled comment with code `suggestion` markdown block from your current selection.

Comments can be also added in the git diff view (SCM panel) on the modified side.

Export with **Rubber Duck: Export Review as Markdown**. Here is an example of the exported Markdown:

```markdown
# Code Review: go-ultimate

**Author:** tsaarni
**Date:** `2026-07-12T13:37:10.555Z`
**Base:** `f4eaef0999ec00e702d95a19a386f3947fdb6f05` "Initial commit"
**Head:** `f4eaef0999ec00e702d95a19a386f3947fdb6f05` "Initial commit" (with uncommitted changes)

---

## examples/runners.go (lines 37-37)
<!-- comment id faf8064e-1aec-49c1-abca-3439ad9082e6, created at 2026-07-12T13:37:19.429Z -->

``go
	time.Sleep(3 * time.Second)
``

tsaarni wrote:
> is this long enough?
```

### Configuration

| Setting | Default | Description |
|---|---|---|
| `rubberDuck.reviewsFilePath` | `.vscode/reviews.json` | Reviews file path, relative to workspace root. |

## Installation

Check out the repo and build:

```bash
git clone https://github.com/tsaarni/rubber-duck-review.git
cd rubber-duck-review
pnpm install
pnpm run compile
pnpm dlx vsce package
```

To install the extension:

```
code --install-extension rubber-duck-review-0.1.0.vsix
```

Or open the Extensions view in VS Code, click `...` at the top, and select **Install from VSIX...**.

## Contributing

Press `F5` in VS Code to launch a debug window with the extension loaded.

| Command | Description |
|---|---|
| `pnpm run compile` | Compile TypeScript. |
| `pnpm run watch` | Compile and watch for changes. |
| `pnpm run lint` | Check for lint and format issues. |
| `pnpm run format` | Auto-fix lint and format issues. |
