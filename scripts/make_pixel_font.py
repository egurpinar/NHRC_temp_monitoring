#!/usr/bin/env python3
"""Cuts Press Start 2P (SIL OFL 1.1) down to the characters roworno.com uses and
renames it, as the licence asks of a modified copy (its Reserved Font Name is
"Press Start 2P"): the result is "Roworno Pixel", WOFF.

    python3 -I make_pixel_font.py IN.ttf OUT.woff
"""
import sys
from fontTools import subset
from fontTools.ttLib import TTFont

src, out = sys.argv[1], sys.argv[2]
UNICODES = (list(range(0x20, 0x7F)) + list(range(0xA0, 0x100))
            + [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x2122, 0x2190, 0x2191, 0x2192, 0x2193])

opts = subset.Options()
opts.flavor = 'woff'
opts.drop_tables += ['DSIG']
opts.name_IDs = ['*']
opts.name_languages = ['*']
opts.layout_features = ['*']
opts.notdef_outline = True

font = TTFont(src)
sub = subset.Subsetter(opts)
sub.populate(unicodes=UNICODES)
sub.subset(font)

FAMILY = 'Roworno Pixel'
for rec in font['name'].names:
    if rec.nameID in (1, 16):
        rec.string = FAMILY
    elif rec.nameID == 4:
        rec.string = FAMILY + ' Regular'
    elif rec.nameID == 6:
        rec.string = 'RowornoPixel-Regular'
    elif rec.nameID == 3:   # the unique name: not the reserved one either
        rec.string = '3.000;RowornoPixel-Regular'
# The copyright (0) and the licence (13, 14) stay as they are.
subset.save_font(font, out, opts)

check = TTFont(out)
names = {r.nameID: r.toUnicode() for r in check['name'].names if r.platformID == 3}
assert names[1] == FAMILY and not any('Press Start 2P' in names.get(i, '') for i in (1, 3, 4, 6, 16)), names
assert names[0].startswith('Copyright 2012 The Press Start 2P Project Authors'), names[0]
assert 'Open Font License' in names[13], names[13]
cmap = check.getBestCmap()
missing = [hex(u) for u in UNICODES if u not in cmap]
print('glyphs', len(check.getGlyphOrder()), 'missing', missing, 'flavor', check.flavor)
