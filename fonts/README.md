# Fonts

`roworno-pixel.woff` is the pixel font of roworno.com/8bit. It is
[Press Start 2P](https://github.com/google/fonts/tree/main/ofl/pressstart2p)
(Copyright 2012 The Press Start 2P Project Authors), cut down to the characters
the site uses and renamed "Roworno Pixel": the SIL Open Font License asks that a
changed copy not carry the original's reserved name. It is under the same
licence, `OFL.txt`.

Browsers fetch it only on the 8-bit page. To make it again (for more characters,
add them to `UNICODES` in the script):

```
curl -fL -o /tmp/PressStart2P-Regular.ttf https://raw.githubusercontent.com/google/fonts/main/ofl/pressstart2p/PressStart2P-Regular.ttf
python3 scripts/make_pixel_font.py /tmp/PressStart2P-Regular.ttf fonts/roworno-pixel.woff
```
