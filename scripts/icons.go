//go:build ignore

// Generate the project's original pulse mark using only the Go standard library.
package main

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
)

type point struct{ x, y float64 }

var pulse = []point{{3, 16}, {9, 16}, {13, 6}, {19, 26}, {23, 16}, {29, 16}}

func main() {
	if err := generate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func generate() error {
	palette := map[string]color.NRGBA{
		"operational": {R: 35, G: 134, B: 54, A: 255}, "attention": {R: 191, G: 135, B: 0, A: 255},
		"outage": {R: 207, G: 34, B: 46, A: 255}, "unknown": {R: 110, G: 119, B: 129, A: 255},
	}
	for name, tint := range palette {
		for _, size := range []int{16, 24, 32} {
			if err := writeIcon(tint, size, fmt.Sprintf("public/icons/%s-%d.png", name, size)); err != nil {
				return err
			}
		}
	}
	for _, size := range []int{16, 32, 48, 128} {
		if err := writeIcon(palette["unknown"], size, fmt.Sprintf("public/icons/%d.png", size)); err != nil {
			return err
		}
	}
	return nil
}
func distance(p, a, b point) float64 {
	dx, dy := b.x-a.x, b.y-a.y
	t := math.Max(0, math.Min(1, ((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy)))
	return math.Hypot(p.x-a.x-t*dx, p.y-a.y-t*dy)
}
func writeIcon(tint color.NRGBA, size int, path string) error {
	out := image.NewNRGBA(image.Rect(0, 0, size, size))
	const samples = 8
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			covered := 0
			for sy := 0; sy < samples; sy++ {
				for sx := 0; sx < samples; sx++ {
					p := point{(float64(x) + (float64(sx)+.5)/samples) * 32 / float64(size), (float64(y) + (float64(sy)+.5)/samples) * 32 / float64(size)}
					for i := 1; i < len(pulse); i++ {
						if distance(p, pulse[i-1], pulse[i]) <= 1.5 {
							covered++
							break
						}
					}
				}
			}
			pixel := tint
			pixel.A = uint8((covered*255 + samples*samples/2) / (samples * samples))
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
