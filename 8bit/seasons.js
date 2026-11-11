/* roworno.com/8bit through the year: the season's pixel art.
 *
 * The <head> script of index.html sets data-season on <html> by the date in
 * New York - halloween (Oct 15-31), christmas (Dec 1-25), newyear (Dec 26 -
 * Jan 1), easter (the ten days up to Easter Monday), july4 (Jun 28 - Jul 5) -
 * and loads this file only then, only on the 8-bit page. The season's colours
 * are in index.html (8-BIT SEASONS), so they are there from the first moment.
 * This draws:
 *   - a scene above the header, in the space index.html keeps for it (nothing
 *     moves when it arrives);
 *   - a few things standing on the header's bottom line;
 *   - on a wide screen, one large one in each margin;
 *   - at Christmas and the New Year, snow falling over the page.
 * All of it is hidden from screen readers, never takes a tap or a click, keeps
 * still for visitors who ask for less motion, and is drawn from the grids below:
 * nothing is fetched, and nothing from outside goes into the page.
 *
 * Tests: scripts/test_site_theme.js, section 8.
 */
(function () {
  'use strict';

  // ── The pictures: one letter a pixel, '.' see-through; f holds the frames. ──
  const SPRITES = {
    // Halloween
    moon: { c: { M: '#fff1b8', m: '#e3cf7f' }, f: [[
      '....MMMM....',
      '..MMMMMMMM..',
      '.MMMMMMMmMM.',
      '.MMmMMMMMMM.',
      'MMMMMMMMMMMM',
      'MMMMMMMMMmMM',
      'MMMMmmMMMMMM',
      'MMMMmmMMMMMM',
      '.MMMMMMMMmM.',
      '.MMMMMMMMMM.',
      '..MMMMMMMM..',
      '....MMMM....']] },
    bat: { c: { K: '#0c0614', E: '#ff5a36' }, f: [[
      'KK.........KK',
      '.KK..K.K..KK.',
      '.KKK.EKE.KKK.',
      '..KKKKKKKKK..',
      '...KKKKKKK...',
      '.....KKK.....',
      '......K......'], [
      '.....K.K.....',
      '.....EKE.....',
      '...KKKKKKK...',
      '.KKKKKKKKKKK.',
      'KKK.KKKKK.KKK',
      'KK...KKK...KK',
      'K.....K.....K']] },
    ghost: { c: { W: '#f7f2ff', w: '#c9bde3', K: '#2a1840' }, f: [[
      '....WWW....',
      '..WWWWWWW..',
      '.WWWWWWWWW.',
      '.WWKWWWKWWw',
      '.WKKWWWKKWw',
      'WWWWWWWWWWW',
      'WWWWWKKWWWw',
      '.WWWWKKWWw.',
      '.WWWWWWWWw.',
      '.WWWWWWWWw.',
      '.WWWWWWWww.',
      '.WW.WWW.Ww.',
      '.W...W...w.']] },
    pumpkin: { c: { G: '#4e8f3a', O: '#ff8a1f', o: '#c8600e', Y: '#ffd23f', y: '#f2a33a' }, f: [[
      '.....GG.....',
      '......G.....',
      '..OOoOOoOO..',
      '.OOOoOOoOOO.',
      'OOYYYOOYYYOO',
      'OOOYOOOOYOOO',
      'OOOOOYYOOOOO',
      'OYOYYYYYYOYO',
      '.OOYYYYYYOO.',
      '..OOOOOOOO..'], [
      '.....GG.....',
      '......G.....',
      '..OOoOOoOO..',
      '.OOOoOOoOOO.',
      'OOyyyOOyyyOO',
      'OOOyOOOOyOOO',
      'OOOOOyyOOOOO',
      'OyOyyyyyyOyO',
      '.OOyyyyyyOO.',
      '..OOOOOOOO..']] },
    cat: { c: { K: '#0c0614', E: '#c8ff4d' }, f: [[
      'K...K.....',
      'KK.KK.....',
      'KKKKK.....',
      'KEKEK.....',
      'KKKKK...K.',
      '.KKK....K.',
      '.KKKK...K.',
      'KKKKKK.K..',
      'KKKKKKKK..',
      'KKKKKKK...',
      '.KK.KK....']] },
    tomb: { c: { T: '#7a7194', t: '#4c4563' }, f: [[
      '..TTT..',
      '.TTTTT.',
      'TTTTTTT',
      'TtttttT',
      'TTTTTTT',
      'TttttTT',
      'TTTTTTT',
      'TTTTTTT']] },
    deadtree: { c: { K: '#0c0614' }, f: [[
      '..K.....K...',
      '...K..K.K..K',
      '.K..K.K..KK.',
      '..K.KKK.K...',
      '...KKKKK....',
      'KK...KK.....',
      '..KK.KK..K..',
      '....KKK.K...',
      '.....KKK....',
      '.....KK.....',
      '.....KK.....',
      '....KKK.....',
      '....KKKK....',
      '...KKKKKK...']] },
    web: { c: { S: '#b9aed0' }, f: [[
      'SSSSSSSSSSSS',
      '.S....S....S',
      '..S...S...SS',
      '..SSSSSSSS.S',
      '....S.S.S..S',
      '.....SSS..SS',
      '.....SSSSS.S',
      '.......S.S.S',
      '........SS.S',
      '.........SSS',
      '..........SS',
      '...........S']] },
    spider: { c: { K: '#8d7fb0', E: '#ff5a36' }, f: [[
      'K.K.K.K',
      '.KKKKK.',
      'KKEKEKK',
      '.KKKKK.',
      'K.K.K.K']] },
    // Christmas and the New Year
    xtree: { c: { Y: '#ffd23f', G: '#2f9a52', g: '#1f6b3a', R: '#ff5a5a', B: '#6cb6ff', N: '#7a4a21' }, f: [[
      '......Y......',
      '.....YYY.....',
      '......G......',
      '.....GGg.....',
      '....GRGgG....',
      '....GGGgg....',
      '...GGgGBgG...',
      '...GGGGGgg...',
      '..GYGGgRGgG..',
      '..GGGGGGGgg..',
      '.GGgGBGGYGgG.',
      '.GGGGGGGGGgg.',
      'GRGGgGGGRGGgG',
      '.....NNN.....',
      '.....NNN.....']] },
    gift1: { c: { R: '#d93b3b', r: '#a82a2a', Y: '#f6c75a' }, f: [[
      '..Y..Y..',
      '...YY...',
      'RRRYYRRR',
      'RRRYYRRr',
      'YYYYYYYY',
      'RRRYYRRr',
      'RRRYYRRr',
      'rrrYYrrr']] },
    gift2: { c: { B: '#3b7bd9', b: '#2a5aa8', W: '#ffffff' }, f: [[
      '.W...W.',
      '..W.W..',
      'BBBWBBB',
      'BBBWBBb',
      'WWWWWWW',
      'BBBWBBb',
      'bbbWbbb']] },
    snowman: { c: { W: '#f7fbff', w: '#c7d6e8', K: '#1b1b2b', O: '#ff8a1f', R: '#d93b3b' }, f: [[
      '...KKK...',
      '...KKK...',
      '..KKKKK..',
      '...WWW...',
      '..WKWKW..',
      '..WWWOO..',
      '...WWw...',
      '..RRRRR..',
      '.WWWKWWw.',
      '.WWWWWWw.',
      'WWWWKWWWw',
      'WWWWWWWWw',
      '.WWWWWww.',
      '..wwwww..']] },
    // For the header's line, where 10 rows fit.
    snowmini: { c: { W: '#f7fbff', w: '#c7d6e8', K: '#1b1b2b', O: '#ff8a1f', R: '#d93b3b' }, f: [[
      '..KKK..',
      '.KKKKK.',
      '..WWW..',
      '.WKWKW.',
      '..WOO..',
      '.RRRRR.',
      'WWWKWWw',
      'WWWWWWw',
      'WWWKWWw',
      '.wwwww.']] },
    flake1: { c: { W: '#ffffff' }, f: [['.W.', 'WWW', '.W.']] },
    flake2: { c: { W: '#ffffff' }, f: [['W...W', '.W.W.', '..W..', '.W.W.', 'W...W']] },
    flake3: { c: { W: '#ffffff', w: '#cfe3ff' }, f: [['...W...', '.W.W.W.', '..WwW..', 'WWwWwWW', '..WwW..', '.W.W.W.', '...W...']] },
    // The lights along the top: a drooping wire, its bulbs lit, then dim.
    lights: { c: { K: '#2e5a43', R: '#ff5a5a', r: '#8a2e2e', Y: '#ffd23f', y: '#8a7120', B: '#6cb6ff', b: '#2e5a85', G: '#6be38a', g: '#2e7a45' }, f: [[
      'KK..........KK..........',
      '..KK......KK..KK......KK',
      '....KKKKKK......KKKKKK..',
      '....R....Y......B....G..',
      '...RRR..YYY....BBB..GGG.',
      '...RRR..YYY....BBB..GGG.'], [
      'KK..........KK..........',
      '..KK......KK..KK......KK',
      '....KKKKKK......KKKKKK..',
      '....r....y......b....g..',
      '...rrr..yyy....bbb..ggg.',
      '...rrr..yyy....bbb..ggg.']] },
    snowfloor: { c: { W: '#f4f8ff', w: '#c9d8ea' }, f: [[
      '..WW....WWW.....',
      '.WWWW..WWWWW..W.',
      'WWWWWWWWWWWWWWWW',
      'WWWwWWWWWWwWWWWW',
      'wWWWWWwWWWWWWwWW']] },
    stars: { c: { W: '#ffffff', w: '#8fa6c9' }, f: [[
      '........................................',
      '...W....................................',
      '.....................w..................',
      '..................................W.....',
      '..........w.............................',
      '........................................',
      '.........................W..............',
      '.w......................................',
      '...............................w........',
      '..............W.........................']] },
    // A firework: the spark going up, the burst, wider, fading, gone.
    burst: { c: { A: '#ffd166', a: '#fff3c4' }, f: [[
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '.......a.......',
      '.......A.......',
      '...............',
      '.......A.......',
      '...............',
      '.......A.......',
      '...............',
      '.......A.......'], [
      '...............',
      '...............',
      '...............',
      '...............',
      '.......A.......',
      '.....A...A.....',
      '......AaA......',
      '....A.aAa.A....',
      '......AaA......',
      '.....A...A.....',
      '.......A.......',
      '...............',
      '...............',
      '...............',
      '...............'], [
      '...............',
      '.......A.......',
      '...A...a...A...',
      '....a.....a....',
      '...............',
      '..A....a....A..',
      '.......A.......',
      'Aa..a.AAA.a..aA',
      '.......A.......',
      '..A....a....A..',
      '...............',
      '....a.....a....',
      '...A...a...A...',
      '.......A.......',
      '...............'], [
      '.......a.......',
      '..a.........a..',
      '...............',
      '...............',
      '.a...........a.',
      '...............',
      '...............',
      'a.............a',
      '...............',
      '...............',
      '.a...........a.',
      '...............',
      '...............',
      '..a.........a..',
      '.......a.......'], [
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............']] },
    // Easter
    cloud: { c: { W: '#ffffff', w: '#d6ecfb' }, f: [[
      '.....WWW.......',
      '...WWWWWWW.WW..',
      '..WWWWWWWWWWWW.',
      'WWWWWWWWWWWWWWW',
      '.wwwwwwwwwwwww.']] },
    egg1: { c: { P: '#ffb3d1', p: '#ff6fa8' }, f: [['..PP..', '.PPPP.', 'pppppp', 'PPPPPP', 'pppppp', 'PPPPPP', '.PPPP.']] },
    egg2: { c: { B: '#a8d8ff', b: '#3f93e0' }, f: [['..BB..', '.BbBB.', 'BBBBbB', 'BbBBBB', 'BBBbBB', 'BbBBbB', '.BBBB.']] },
    egg3: { c: { Y: '#ffe38a', y: '#e0a000' }, f: [['..YY..', '.YYYY.', 'YyYYyY', 'yYyyYy', 'YYYYYY', 'YYYYYY', '.YYYY.']] },
    egg4: { c: { L: '#d6b8ff', l: '#9a6be0' }, f: [['..LL..', '.LLLL.', 'LLLLLL', 'llllll', 'LlLlLl', 'LLLLLL', '.LLLL.']] },
    grass: { c: { G: '#6cc070', g: '#3f9a4a' }, f: [[
      '.g.....g..g.....',
      '.g..g..gg.g...g.',
      'gGg.g.gGgGg.g.gg',
      'GGGgGgGGGGGgGgGG',
      'GGGGGGGGGGGGGGGG']] },
    tulip: { c: { R: '#ff6f91', r: '#d9466c', G: '#3f9a4a' }, f: [['R.R.R', 'RRrRR', 'RRRRR', '.RRR.', '..G..', 'G.G..', '.GG.G', '..GG.', '..G..']] },
    daisy: { c: { W: '#ffffff', w: '#c9c3d6', Y: '#ffc72c', G: '#3f9a4a' }, f: [['.W.W.', 'WwYwW', '.YYY.', 'WwYwW', '.W.W.', '..G..', '..G.G', '.GGG.', '..G..']] },
    bunny: { c: { W: '#f6f3f8', K: '#7d7489', P: '#ffb3c8', E: '#3a2f3f' }, f: [[
      '..K.K.......',
      '.KPKPK......',
      '.KPKPK......',
      '.KWKWK......',
      'KWWWWWK.....',
      'KWEWWWK.....',
      'KWWWPWK.KK..',
      '.KWWWWKKWWK.',
      '.KWWWWWWWWWK',
      'KWWWWWWWWWWK',
      'KWWWWWWWWWWK',
      '.KWWKKKWWWK.',
      '..KK...KKK..'], [
      '..K.K.......',
      '.KPKPK......',
      '.KPKPK......',
      '.KWKWK......',
      'KWWWWWK.....',
      'KWEWWWK..KK.',
      'KWWWPWKKKWWK',
      '.KWWWWWWWWWK',
      '.KWWWWWWWWWK',
      '..KWWWWWWWK.',
      '.KWK....KWK.',
      'KWK......KWK',
      '.K........K.']] },
    bunnymini: { c: { W: '#f6f3f8', K: '#7d7489', P: '#ffb3c8', E: '#3a2f3f' }, f: [[
      '.K.K......',
      'KPKPK.....',
      'KWKWK.....',
      'KWWWWK....',
      'KWEWWK.KK.',
      'KWWPWKKWWK',
      '.KWWWWWWWK',
      '.KWWWWWWK.',
      '..KK..KK..'], [
      '.K.K......',
      'KPKPK.....',
      'KWKWK.....',
      'KWWWWK....',
      'KWEWWKKKK.',
      'KWWPWKWWWK',
      '.KWWWWWWWK',
      'KWK....KWK',
      'K.......K.']] },
    chick: { c: { Y: '#ffd84d', y: '#d9a400', O: '#ff9a1f', K: '#2b2b2b' }, f: [[
      '..yyy...',
      '.yYYYy..',
      '.yYKYyOO',
      '.yYYYy..',
      'yYYYYYy.',
      'yYYYYYy.',
      '.yyyyy..',
      '..O.O...'], [
      '........',
      '..yyy...',
      '.yYYYy..',
      '.yYKYy..',
      'yYYYYYyO',
      'yYYYYYyO',
      '.yyyyy..',
      '..O.O...']] },
    butterfly: { c: { P: '#ff8fc7', p: '#e0559d', O: '#ffb347', K: '#4a3a55' }, f: [[
      'PP.K.PP',
      'PpPKPpP',
      'PPPKPPP',
      '.OOKOO.',
      '.OO.OO.'], [
      '...K...',
      '.PPKPP.',
      '.PpKpP.',
      '..OKO..',
      '..O.O..']] },
    // The Fourth of July
    gingham: { c: { R: '#d6333a', r: '#f08a8e', W: '#fff7ef' }, f: [['RRrrRRrr', 'RRrrRRrr', 'rrWWrrWW', 'rrWWrrWW']] },
    grill: { c: { K: '#2b2b33', k: '#55556a', D: '#c8553d', d: '#8a3220', S: '#9aa0ad' }, f: [[
      '..DDDDdDDDDd..',
      'KKKKKKKKKKKKKK',
      '.KkkkkkkkkkkK.',
      '.KkkkkkkkkkkK.',
      '..KkkkkkkkkK..',
      '...KKKKKKKK...',
      '....K.KK.K....',
      '...K..KK..K...',
      '..K...KK...K..',
      '.SS...KK...SS.']] },
    smoke: { c: { S: '#d9dee8', s: '#aab2c2' }, f: [['.SS.', 'SSsS', 'SsSS', '.SS.']] },
    hotdog: { c: { B: '#e8b26a', b: '#b9813f', D: '#c8553d', Y: '#ffd23f' }, f: [[
      '..DDDDDDDDDD..',
      '.DDYDDYDDYDDD.',
      'BBBBBBBBBBBBBB',
      'bBBBBBBBBBBBBb',
      '.bbbbbbbbbbbb.']] },
    melon: { c: { R: '#ff5a5a', K: '#1b1b1b', W: '#c9f2b5', G: '#2f8f3a' }, f: [[
      'RRRRRRRRRRRR',
      '.RRKRRRRKRR.',
      '..RRRRKRRR..',
      '...RRRRRR...',
      '....WWWW....',
      '.....GG.....']] },
  };

  // Fireworks in more than one colour: the same burst, its two colours swapped.
  const BURSTS = {
    gold: { A: '#ffd166', a: '#fff3c4' },
    red: { A: '#ff4d4d', a: '#ffc2c2' },
    blue: { A: '#6cb6ff', a: '#d6ecff' },
    white: { A: '#ffffff', a: '#cfe3ff' },
    green: { A: '#6be38a', a: '#d2f7dc' },
  };

  /**
   * What each season puts where. In the scene above the header (20 picture
   * pixels high inside its frame): x from the left in % of its width, or r
   * from the right; t from the top or b from the bottom - in picture pixels,
   * so the scene keeps its shape at 2 or 3 screen pixels a picture pixel. On
   * the header's line (10 rows fit there): r from the right. In the margins:
   * k, the size. move: how it moves (not at all when motion is turned down).
   */
  const SCENES = {
    halloween: {
      ground3: true,
      scene: [
        { s: 'moon', x: 4, t: 1 },
        { s: 'web', r: 0, t: 0 },
        { s: 'spider', r: 4, t: 8, move: 'dangle' },
        { s: 'ghost', x: 60, t: 1, move: 'bob' },
        { s: 'pumpkin', x: 17, b: 1, move: 'flicker' },
        { s: 'tomb', x: 28, b: 2 },
        { s: 'tomb', x: 35, b: 2 },
        { s: 'cat', x: 43, b: 3 },
        { s: 'pumpkin', x: 50, b: 1, move: 'flicker', delay: -1.4 },
        { s: 'deadtree', x: 76, b: 2 },
        { s: 'bat', move: 'fly', t: 1, dur: 11, delay: -2 },
        { s: 'bat', move: 'fly', t: 7, dur: 15, delay: -9, reverse: true },
      ],
      ground: [{ s: 'pumpkin', r: 4, move: 'flicker' }, { s: 'pumpkin', r: 20, move: 'flicker', delay: -2.1 }],
      margins: [{ s: 'pumpkin', k: 6, move: 'flicker' }, { s: 'ghost', k: 6, move: 'bob' }],
    },
    christmas: {
      floor: 'snowfloor', sky: 'stars', lights: 'lights',
      scene: [
        { s: 'snowman', x: 6, b: 3 },
        { s: 'gift2', x: 71, b: 3 },
        { s: 'xtree', x: 77, b: 3 },
        { s: 'gift1', x: 90, b: 3 },
      ],
      drift: true,
      ground: [{ s: 'gift1', r: 4 }, { s: 'gift2', r: 14 }, { s: 'snowmini', r: 24 }],
      margins: [{ s: 'xtree', k: 6 }, { s: 'snowman', k: 6 }],
      snow: true,
    },
    newyear: {
      floor: 'snowfloor', sky: 'stars', lights: 'lights',
      scene: [
        { s: 'snowman', x: 6, b: 3 },
        { s: 'burst', x: 22, t: 2, move: 'burst', color: 'gold', dur: 3.2, delay: -0.4 },
        { s: 'burst', x: 40, t: 3, move: 'burst', color: 'white', dur: 4.1, delay: -2.3 },
        { s: 'burst', x: 57, t: 1, move: 'burst', color: 'green', dur: 3.7, delay: -1.1 },
        { s: 'xtree', x: 77, b: 3 },
        { s: 'gift1', x: 90, b: 3 },
      ],
      drift: true,
      ground: [{ s: 'gift1', r: 4 }, { s: 'gift2', r: 14 }, { s: 'snowmini', r: 24 }],
      margins: [{ s: 'xtree', k: 6 }, { s: 'snowman', k: 6 }],
      snow: true,
    },
    easter: {
      floor: 'grass',
      scene: [
        { s: 'cloud', x: 8, t: 1 },
        { s: 'cloud', x: 62, t: 3 },
        { s: 'tulip', x: 16, b: 3 },
        { s: 'egg1', x: 22, b: 2 },
        { s: 'daisy', x: 28, b: 3 },
        { s: 'egg2', x: 34, b: 2 },
        { s: 'bunny', x: 44, b: 3, move: 'hop' },
        { s: 'chick', x: 58, b: 3, move: 'peck' },
        { s: 'egg3', x: 66, b: 2 },
        { s: 'tulip', x: 74, b: 3 },
        { s: 'egg4', x: 82, b: 2 },
        { s: 'daisy', x: 90, b: 3 },
        { s: 'butterfly', move: 'flutter', t: 1, dur: 17, delay: -4 },
        { s: 'butterfly', move: 'flutter', t: 4, dur: 22, delay: -15, reverse: true },
      ],
      ground: [{ s: 'egg2', r: 4 }, { s: 'egg1', r: 12 }, { s: 'tulip', r: 20 }, { s: 'bunnymini', move: 'patrol' }],
      margins: [{ s: 'bunny', k: 6, move: 'hop' }, { s: 'chick', k: 8, move: 'peck' }],
    },
    july4: {
      floor: 'gingham', sky: 'stars',
      scene: [
        { s: 'grill', x: 6, b: 4, move: 'smoke' },
        { s: 'hotdog', x: 22, b: 4 },
        { s: 'melon', x: 34, b: 4 },
        { s: 'burst', x: 46, t: 1, move: 'burst', color: 'red', dur: 3.4, delay: -0.6 },
        { s: 'burst', x: 62, t: 2, move: 'burst', color: 'white', dur: 4.2, delay: -2.6 },
        { s: 'burst', x: 76, t: 0, move: 'burst', color: 'blue', dur: 3.8, delay: -1.5 },
        { s: 'hotdog', x: 88, b: 4 },
      ],
      ground: [{ s: 'melon', r: 4 }, { s: 'hotdog', r: 18 }],
      margins: [{ s: 'grill', k: 6, move: 'smoke' }, { s: 'melon', k: 6 }],
    },
  };

  const SEASONS = Object.keys(SCENES);

  /**
   * The scene's height (its frame included; index.html keeps room for it) and
   * screen pixels a picture pixel: a phone, and anything 600px wide or more.
   */
  const SCENE_SIZE = { narrow: { height: 48, k: 2 }, wide: { height: 72, k: 3 } };
  /** The header's line: 20px high (its padding is 22px), at 2 screen pixels a picture pixel. */
  const GROUND = { height: 20, k: 2 };

  /** A sprite's size: { w, h, n } - picture pixels wide and high, and its frames. */
  function size(name) {
    const f = SPRITES[name].f;
    return { w: f[0][0].length, h: f[0].length, n: f.length };
  }

  /**
   * A sprite as an image address: an SVG of its frames side by side, one
   * rectangle per run of a colour in a row. colors: other colours for its
   * letters (the fireworks).
   */
  function svgUri(name, colors) {
    const sp = SPRITES[name], { w, h, n } = size(name), c = Object.assign({}, sp.c, colors || {});
    let rects = '';
    sp.f.forEach((rows, k) => rows.forEach((row, y) => {
      for (let x = 0; x < w;) {
        const ch = row[x];
        let run = 1;
        while (x + run < w && row[x + run] === ch) run++;
        if (ch !== '.') rects += `<rect x="${k * w + x}" y="${y}" width="${run}" height="1" fill="${c[ch]}"/>`;
        x += run;
      }
    }));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * n}" height="${h}" viewBox="0 0 ${w * n} ${h}" shape-rendering="crispEdges">${rects}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }

  // The styles, written into the page once; rules for a sprite's frames are
  // added as they are needed (they depend on its size).
  const CSS = [
    `.px-scene{position:absolute;top:12px;left:16px;right:16px;height:${SCENE_SIZE.wide.height}px;overflow:hidden;border:4px solid var(--px-line);box-shadow:4px 4px 0 var(--px-shadow);pointer-events:none;}`,
    `@media(max-width:599px){.px-scene{height:${SCENE_SIZE.narrow.height}px;}}`,
    '.px-scene i,.px-scene b,.px-ground i,.px-ground b,.px-margins i,.px-margins b,.px-snow i{position:absolute;display:block;background-repeat:no-repeat;pointer-events:none;}',
    '.px-tile{left:0;right:0;background-repeat:repeat-x !important;}',
    '.px-sky{left:0;top:0;right:0;bottom:0;background-repeat:repeat !important;}',
    `.px-ground{position:absolute;right:0;bottom:0;width:50%;height:${GROUND.height}px;pointer-events:none;}`,
    '.px-margins{position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:0;display:none;}',
    '@media(min-width:1100px){.px-margins{display:block;}}',
    '.px-snow{position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:5;overflow:hidden;}',
    // Skies. Halloween's last band is the ground the silhouettes stand on (3 picture pixels).
    '.px-halloween{background:linear-gradient(#1d0f33 0 30%,#33154c 30% 48%,#561c54 48% 62%,#8a2a4b 62% 74%,#cc5a2c 74% calc(100% - var(--px-g)),#0c0614 calc(100% - var(--px-g)));}',
    '.px-christmas,.px-newyear{background:linear-gradient(#081629 0 45%,#0d2140 45% 75%,#12294d 75%);}',
    '.px-easter{background:linear-gradient(#bfe3ff 0 40%,#d6eeff 40% 72%,#e9f7ff 72%);}',
    '.px-july4{background:linear-gradient(#050f22 0 45%,#0a1a36 45% 75%,#0f2347 75%);}',
    '.px-thread{background:#b9aed0;}',
    '@keyframes px-fly{from{transform:translateX(-48px);}to{transform:translateX(100%);}}',
    '@keyframes px-flutter{0%{transform:translate(-24px,6px);}20%{transform:translate(20%,0);}40%{transform:translate(40%,9px);}60%{transform:translate(60%,2px);}80%{transform:translate(80%,8px);}100%{transform:translate(100%,3px);}}',
    '@keyframes px-bob{0%,100%{transform:translateY(0);}50%{transform:translateY(-4px);}}',
    '@keyframes px-dangle{0%,100%{transform:translateY(0);}50%{transform:translateY(8px);}}',
    '@keyframes px-hop{0%,100%{transform:translateY(0);}50%{transform:translateY(-2px);}}',
    '@keyframes px-rise{0%{transform:translateY(0);opacity:.9;}100%{transform:translateY(-18px);opacity:0;}}',
    '@keyframes px-face{0%,50%{transform:scaleX(-1);}50.01%,100%{transform:scaleX(1);}}',
    '@keyframes px-fall{0%{transform:translate(0,-16px);}25%{transform:translate(6px,25vh);}50%{transform:translate(0,50vh);}75%{transform:translate(-6px,75vh);}100%{transform:translate(0,104vh);}}',
    '@media (prefers-reduced-motion: reduce){.px-scene *,.px-ground *,.px-margins *{animation:none !important;}.px-snow{display:none;}}',
    '@media print{.px-scene,.px-ground,.px-margins,.px-snow{display:none;}}',
  ].join('\n');

  /** The keyframes for a sprite's frames at k screen pixels a pixel. */
  function frameRules(name, k) {
    const { w, n } = size(name), step = w * k, id = `${name}-${k}`;
    return [
      // Frame after frame.
      `@keyframes px-f-${id}{to{background-position:-${step * n}px 0;}}`,
      // A candle's flicker: mostly the first, now and then the second.
      `@keyframes px-flick-${id}{0%,64%{background-position:0 0;}66%,70%{background-position:-${step}px 0;}72%,84%{background-position:0 0;}86%,100%{background-position:-${step}px 0;}}`,
      // A firework: four pictures, then nothing until the next.
      `@keyframes px-burst-${id}{0%{background-position:0 0;}8%{background-position:-${step}px 0;}16%{background-position:-${step * 2}px 0;}34%{background-position:-${step * 3}px 0;}52%,100%{background-position:-${step * 4}px 0;}}`,
      // The lights: the strip repeats, so one picture along swaps every bulb from lit to dim.
      `@keyframes px-tw-${id}{0%,49%{background-position:0 0;}50%,100%{background-position:-${step}px 0;}}`,
      // Back and forth along a line, the sprite's own width short of its end.
      `@keyframes px-patrol-${id}{0%{transform:translateX(0);}50%{transform:translateX(calc(100% - ${step}px));}100%{transform:translateX(0);}}`,
    ].join('\n');
  }

  /**
   * Draws a season into the page. doc: the document; season: its name;
   * opts.still: no motion; opts.width: the window's width (the scene's size,
   * the number of snowflakes); opts.random: Math.random or a stand-in.
   * Returns the elements it added.
   */
  function build(doc, season, opts) {
    opts = opts || {};
    const plan = SCENES[season];
    if (!plan) return [];
    const random = opts.random || Math.random;
    const still = !!opts.still;
    const width = opts.width || 1024;
    const added = [];
    const rules = new Set();
    const style = doc.createElement('style');
    style.id = 'px-season-css';
    style.textContent = CSS;
    const need = (name, k) => { const id = `${name}-${k}`; if (!rules.has(id)) { rules.add(id); style.textContent += '\n' + frameRules(name, k); } };

    const make = (tag, cls) => { const el = doc.createElement(tag); if (cls) el.className = cls; return el; };
    /** A sprite at k screen pixels a pixel; frame: the one shown when nothing moves. */
    const sprite = (name, k, colors, frame) => {
      const { w, h, n } = size(name);
      const el = make('i');
      el.style.width = `${w * k}px`;
      el.style.height = `${h * k}px`;
      el.style.backgroundImage = svgUri(name, colors);
      el.style.backgroundSize = `${w * k * n}px ${h * k}px`;
      if (frame) el.style.backgroundPosition = `-${w * k * frame}px 0`;
      return el;
    };
    /** A strip repeated along (the floor, the lights, the snow on the header's line). */
    const tile = (name, k, edge) => {
      const el = sprite(name, k);
      el.className = 'px-tile';
      el.style.width = '';
      el.style[edge] = '0';
      return el;
    };
    const place = (el, it, k) => {
      if (it.x !== undefined) el.style.left = `${it.x}%`;
      if (it.r !== undefined) el.style.right = `${it.r * k}px`;
      if (it.t !== undefined) el.style.top = `${it.t * k}px`;
      if (it.b !== undefined) el.style.bottom = `${it.b * k}px`;
      return el;
    };
    const anim = (el, value) => { if (!still) el.style.animation = value; return el; };

    /** One thing, placed and moving as its plan says. */
    const thing = (it, k) => {
      const name = it.s, { w, h, n } = size(name), delay = it.delay || 0;
      if (it.move === 'fly' || it.move === 'flutter') {
        // Across the scene: a band as wide as the scene moves, the sprite at its left end.
        const band = make('b');
        band.style.left = '0'; band.style.width = '100%'; band.style.top = `${it.t * k}px`; band.style.height = `${h * k}px`;
        // Still, they wait in the sky instead.
        band.style.transform = `translateX(${it.reverse ? 70 : 30}%)`;
        anim(band, `px-${it.move} ${it.dur}s linear ${delay}s infinite${it.reverse ? ' reverse' : ''}`);
        const el = sprite(name, k);
        if (n > 1) { need(name, k); anim(el, `px-f-${name}-${k} ${it.move === 'fly' ? 0.36 : 0.3}s steps(${n}) infinite`); }
        if (it.reverse) el.style.transform = 'scaleX(-1)';
        band.appendChild(el);
        return band;
      }
      if (it.move === 'patrol') {
        // Back and forth along the header's line, facing the way it goes, hopping.
        const band = make('b');
        band.style.left = '0'; band.style.width = '100%'; band.style.bottom = '0'; band.style.height = `${h * k}px`;
        need(name, k);
        anim(band, `px-patrol-${name}-${k} 26s linear infinite`);
        const face = make('b');
        face.style.left = '0'; face.style.top = '0'; face.style.width = `${w * k}px`; face.style.height = `${h * k}px`;
        anim(face, 'px-face 26s linear infinite');
        const el = sprite(name, k);
        anim(el, `px-f-${name}-${k} 0.7s steps(${n}) infinite, px-hop 0.7s steps(2) infinite`);
        face.appendChild(el);
        band.appendChild(face);
        return band;
      }
      if (it.move === 'burst') {
        const el = place(sprite(name, k, BURSTS[it.color], 2), it, k);   // still: the burst at its widest
        need(name, k);
        anim(el, `px-burst-${name}-${k} ${it.dur}s steps(1,end) ${delay}s infinite`);
        // Each time, somewhere else in the sky.
        if (!still && el.addEventListener) {
          el.addEventListener('animationiteration', () => {
            el.style.left = `${Math.round(10 + random() * 72)}%`;
            el.style.top = `${Math.round(random() * 3) * k}px`;
          });
        }
        return el;
      }
      if (it.move === 'dangle') {
        // A spider on its thread, up and down.
        const band = place(make('b'), it, k);
        band.style.width = `${w * k}px`; band.style.height = `${h * k}px`;
        const thread = make('i', 'px-thread');
        thread.style.left = `${Math.floor(w / 2) * k}px`;
        thread.style.width = `${k}px`;
        thread.style.top = `-${20 * k}px`;
        thread.style.height = `${20 * k}px`;
        band.appendChild(thread);
        band.appendChild(sprite(name, k));
        anim(band, 'px-dangle 4s steps(8) infinite');
        return band;
      }
      if (it.move === 'smoke') {
        // A grill, with smoke coming up from it.
        const box = place(make('b'), it, k);
        box.style.width = `${w * k}px`; box.style.height = `${h * k}px`;
        box.appendChild(sprite(name, k));
        if (!still) {
          for (let i = 0; i < 3; i++) {
            const puff = sprite('smoke', k);
            puff.style.left = `${(3 + i * 3) * k}px`;
            puff.style.top = `${-4 * k}px`;
            anim(puff, `px-rise 2.4s steps(8) ${-i * 0.8}s infinite`);
            box.appendChild(puff);
          }
        }
        return box;
      }
      const el = place(sprite(name, k), it, k);
      if (it.move === 'bob') anim(el, `px-bob 2.4s steps(6) ${delay}s infinite`);
      if (it.move === 'flicker') { need(name, k); anim(el, `px-flick-${name}-${k} 3.1s steps(1,end) ${delay}s infinite`); }
      if (it.move === 'hop' || it.move === 'peck') { need(name, k); anim(el, `px-f-${name}-${k} ${it.move === 'hop' ? 1.4 : 1.1}s steps(${n}) ${delay}s infinite`); }
      return el;
    };

    // The scene above the header, in the room index.html keeps for it.
    const app = doc.getElementById('app');
    if (app) {
      const k = (width >= 600 ? SCENE_SIZE.wide : SCENE_SIZE.narrow).k;
      const scene = make('div', `px-scene px-${season}`);
      scene.setAttribute('aria-hidden', 'true');
      if (plan.ground3) scene.style.setProperty('--px-g', `${3 * k}px`);
      if (plan.sky) {
        const sky = sprite(plan.sky, k);
        sky.className = 'px-sky';
        sky.style.width = ''; sky.style.height = '';
        scene.appendChild(sky);
      }
      if (plan.floor) {
        const floor = tile(plan.floor, k, 'bottom');
        floor.style.height = `${size(plan.floor).h * k}px`;
        scene.appendChild(floor);
      }
      if (plan.lights) {
        const lights = tile(plan.lights, k, 'top');
        lights.style.height = `${size(plan.lights).h * k}px`;
        need(plan.lights, k);
        anim(lights, `px-tw-${plan.lights}-${k} 1.6s linear infinite`);
        scene.appendChild(lights);
      }
      for (const it of plan.scene) scene.appendChild(thing(it, k));
      app.insertBefore(scene, app.firstChild);
      added.push(scene);
    }

    // Standing on the header's bottom line, in its padding, clear of its words.
    const header = doc.querySelector ? doc.querySelector('.header') : null;
    if (header && plan.ground) {
      const k = GROUND.k;
      const ground = make('div', 'px-ground');
      ground.setAttribute('aria-hidden', 'true');
      if (plan.drift) {
        const drift = tile('snowfloor', k, 'bottom');
        drift.style.height = `${size('snowfloor').h * k}px`;
        ground.appendChild(drift);
      }
      for (const it of plan.ground) ground.appendChild(thing(Object.assign({ b: 0 }, it), k));
      header.appendChild(ground);
      added.push(ground);
    }

    // On a wide screen, a large one in the middle of each margin, near the bottom.
    const body = doc.body;
    if (body && plan.margins) {
      const margins = make('div', 'px-margins');
      margins.setAttribute('aria-hidden', 'true');
      plan.margins.forEach((it, i) => {
        const k = it.k, { w } = size(it.s);
        const el = thing({ s: it.s, move: it.move }, k);
        el.style.bottom = '32px';
        // The middle of a margin: a quarter of what the 900px column leaves.
        el.style[i === 0 ? 'left' : 'right'] = `calc((100vw - 900px) / 4 - ${(w * k) / 2}px)`;
        margins.appendChild(el);
      });
      body.appendChild(margins);
      added.push(margins);
    }

    // Snow over everything at Christmas and the New Year - none for visitors who turn motion down.
    if (body && plan.snow && !still) {
      const snow = make('div', 'px-snow');
      snow.setAttribute('aria-hidden', 'true');
      const count = width < 600 ? 18 : 36;
      for (let i = 0; i < count; i++) {
        const kind = ['flake1', 'flake2', 'flake3'][Math.floor(random() * 3)];
        const flake = sprite(kind, kind === 'flake1' ? 2 : 1);
        const dur = 9 + random() * 9;
        flake.style.left = `${(random() * 100).toFixed(1)}%`;
        flake.style.top = '0';
        flake.style.opacity = (0.55 + random() * 0.45).toFixed(2);
        flake.style.animation = `px-fall ${dur.toFixed(1)}s linear ${(-random() * dur).toFixed(1)}s infinite`;
        snow.appendChild(flake);
      }
      body.appendChild(snow);
      added.push(snow);
    }

    (doc.head || body).appendChild(style);
    added.push(style);
    return added;
  }

  /** Takes a season's drawing out of the page again. */
  function clear(doc) {
    const all = doc.querySelectorAll ? doc.querySelectorAll('.px-scene,.px-ground,.px-margins,.px-snow,#px-season-css') : [];
    for (const el of Array.from(all)) if (el.parentNode) el.parentNode.removeChild(el);
  }

  /**
   * In the page: the season <html> names, drawn once the page is there, and
   * again when the window crosses 600px wide or motion is turned down or up.
   * Never in the way of the page.
   */
  function start() {
    const doc = document;
    const season = doc.documentElement.getAttribute('data-season');
    if (!SCENES[season]) return;
    const media = (q) => { try { return window.matchMedia(q); } catch (e) { return null; } };
    const calm = media('(prefers-reduced-motion: reduce)'), wide = media('(min-width: 600px)');
    const draw = () => {
      try {
        clear(doc);
        build(doc, season, { still: !!(calm && calm.matches), width: window.innerWidth });
      } catch (e) { /* decorations only */ }
    };
    for (const mq of [calm, wide]) {
      try { if (mq && mq.addEventListener) mq.addEventListener('change', draw); } catch (e) { /* drawn once */ }
    }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', draw);
    else draw();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SPRITES, BURSTS, SCENES, SEASONS, SCENE_SIZE, GROUND, size, svgUri, frameRules, build, clear };
  } else {
    start();
  }
})();
