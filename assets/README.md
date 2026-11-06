# GitHub icon source

`mark-github.svg` is the official `mark-github-16` icon from [Primer Octicons](https://github.com/primer/octicons). The exact source revision is recorded in `octicons-commit.txt`. Its MIT license is bundled in `public/licenses/octicons-LICENSE.txt` and included in the extension package.

`mark-github-mask.png` is a 512 × 512 black-on-white rasterization of that SVG. It is a build source, not a runtime asset. The Go generator converts coverage to transparency and produces neutral application icons plus green, yellow, red, and gray toolbar variants. PNGs are committed so building the extension does not require Go or browser-based asset generation.

Regenerate the color variants from the mask with:

```bash
go run scripts/icons.go
```

To regenerate the mask, use the installed Playwright Chromium (the same external tool used for browser tests):

```bash
sed 's/width="16" height="16"/width="512" height="512"/' assets/mark-github.svg > /tmp/github-status-mark.svg
npm exec --no -- playwright screenshot --channel chromium --viewport-size '512,512' file:///tmp/github-status-mark.svg assets/mark-github-mask.png
go run scripts/icons.go
```
