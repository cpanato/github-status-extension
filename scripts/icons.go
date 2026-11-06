//go:build ignore

// Generate the extension's local PNG assets with the Go standard library.
package main

import (
 "fmt"
 "image"
 "image/color"
 "image/png"
 "os"
)

func main() {
 for _, size := range []int{16, 32, 48, 128} {
  img := image.NewNRGBA(image.Rect(0, 0, size, size))
  for y := 0; y < size; y++ { for x := 0; x < size; x++ {
   dx, dy := float64(x)-float64(size-1)/2, float64(y)-float64(size-1)/2
   if dx*dx+dy*dy < float64(size*size)*.21 { img.Set(x,y,color.NRGBA{R:110,G:119,B:129,A:255}) }
   if dx*dx+dy*dy < float64(size*size)*.025 { img.Set(x,y,color.NRGBA{R:255,G:255,B:255,A:255}) }
  } }
  f, err := os.Create(fmt.Sprintf("public/icons/%d.png",size)); if err != nil { panic(err) }
  if err := png.Encode(f,img); err != nil { panic(err) }; if err := f.Close(); err != nil { panic(err) }
 }
}
