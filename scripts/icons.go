//go:build ignore

// Generate transparent GitHub status icons from the checked-in Octicons mask.
package main

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
)

func main() {
	if err := generate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func generate() error {
	f, err := os.Open("assets/mark-github-mask.png")
	if err != nil {
		return err
	}
	mask, err := png.Decode(f)
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	palette := map[string]color.NRGBA{
		"operational": {R: 35, G: 134, B: 54, A: 255},
		"attention":   {R: 191, G: 135, B: 0, A: 255},
		"outage":      {R: 207, G: 34, B: 46, A: 255},
		"unknown":     {R: 110, G: 119, B: 129, A: 255},
	}
	for name, tint := range palette {
		for _, size := range []int{16, 24, 32} {
			if err := writeIcon(mask, tint, size, fmt.Sprintf("public/icons/%s-%d.png", name, size)); err != nil {
				return err
			}
		}
	}
	for _, size := range []int{16, 32, 48, 128} {
		if err := writeIcon(mask, palette["unknown"], size, fmt.Sprintf("public/icons/%d.png", size)); err != nil {
			return err
		}
	}
	return nil
}

func writeIcon(mask image.Image, tint color.NRGBA, size int, path string) error {
	out := image.NewNRGBA(image.Rect(0, 0, size, size))
	bounds := mask.Bounds()
	// Area-average the high-resolution mask with transparent padding. This keeps
	// the GitHub silhouette legible at 16px and avoids clipping its outer circle.
	const samples = 32
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var coverage uint64
			for sy := 0; sy < samples; sy++ {
				for sx := 0; sx < samples; sx++ {
					u := (float64(x) + (float64(sx)+0.5)/samples) / float64(size)
					v := (float64(y) + (float64(sy)+0.5)/samples) / float64(size)
					u = (u-0.5)/0.9 + 0.5
					v = (v-0.5)/0.9 + 0.5
					if u < 0 || u >= 1 || v < 0 || v >= 1 {
						continue
					}
					p := color.GrayModel.Convert(mask.At(bounds.Min.X+int(u*float64(bounds.Dx())), bounds.Min.Y+int(v*float64(bounds.Dy())))).(color.Gray)
					coverage += uint64(255 - p.Y)
				}
			}
			pixel := tint
			pixel.A = uint8((coverage + samples*samples/2) / (samples * samples))
			out.SetNRGBA(x, y, pixel)
		}
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if err := png.Encode(f, out); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}
