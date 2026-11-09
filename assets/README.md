# Status mark

`status-mark.svg` is an original geometric pulse mark created for this project. It represents service health and does not contain GitHub artwork. The interface uses the GitHub name only to identify the monitored service.

The build bundles the SVG as `icons/status.svg` for popup and settings headers. A CSS mask follows the selected theme. The Go standard-library generator renders the same geometry into neutral application PNGs and green/yellow/red/gray toolbar variants, including transparency and antialiasing.

```bash
go run scripts/icons.go
```

PNGs are committed, so building the extension does not require Go. Regeneration requires no external images, fonts, rasterization tools, or network access.
