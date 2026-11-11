/* roworno.com through the year: the season's pixel art, on the main page and
 * on the 8-bit one (roworno.com/8bit).
 *
 * The <head> script of index.html sets data-season on <html> by the date in
 * New York - halloween (Oct 15-31), christmas (Dec 1-25), newyear (Dec 26 -
 * Jan 1), easter (the ten days up to Easter Monday), july4 (Jun 28 - Jul 5) -
 * and loads this file only then. The season's colours are in index.html
 * (SEASONS, and 8-BIT SEASONS), so they are there from the first moment. This
 * draws:
 *   - a scene above the header, in the space index.html keeps for it (nothing
 *     moves when it arrives), and another at the end of the page;
 *   - a few things standing on the header's bottom line;
 *   - on a wide screen, three in each margin;
 *   - now and then, things crossing the page (bats, butterflies, a sleigh),
 *     and at Christmas and the New Year, snow falling over it.
 * Framed as the page frames its boxes: square with a hard shadow on the 8-bit
 * page, rounded on the main one. All of it is hidden from screen readers,
 * never takes a tap or a click, keeps still for visitors who ask for less
 * motion, and is drawn from the grids below: nothing is fetched, and nothing
 * from outside goes into the page.
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
    // More (November 2026): ghouls, skeletons, a witch; snowmen, a reindeer, a sleigh; a hatching chick, a lamb; a picnic.
    ghoul: { c: { G: '#8fbf6a', g: '#5d8a45', K: '#1b1324', T: '#6a5b8a', t: '#4d4066', D: '#4a3424', d: '#2e1f15' }, f: [[
      '....GGGG....',
      '...GGGGGG...',
      '...GKGGKG...',
      '...GGGGGG...',
      '....GKKG....',
      'GGG.TTTT.GGG',
      'GGgTTTTTTgGG',
      '...TTtTTT...',
      '...TTTTtT...',
      '...TtTTTT...',
      '..DDTTTTDD..',
      '.DDDDdDDDDD.',
      'DDdDDDDDdDDD',
      'DDDDDDDDDDDD'], [
      '....GGGG....',
      '...GGGGGG...',
      '...GKGGKG...',
      '...GGGGGG...',
      'G...GKKG...G',
      'GG.TTTTTT.GG',
      '.GgTTTTTTgG.',
      '...TTtTTT...',
      '...TTTTtT...',
      '...TtTTTT...',
      '..DDTTTTDD..',
      '.DDDDdDDDDD.',
      'DDdDDDDDdDDD',
      'DDDDDDDDDDDD']] },
    skeleton: { c: { W: '#f2efe6', w: '#b9b3a5', K: '#1b1324' }, f: [[
      '...WWW...',
      '..WWWWW..',
      '..WKWKW..',
      '..WWWWW..',
      '...WwW...',
      '....W....',
      'W.WWWWW.W',
      '.W.WwW.W.',
      '...WWW...',
      '...WwW...',
      '....W....',
      '...WWW...',
      '..W...W..',
      '.WW...WW.'], [
      '...WWW...',
      '..WWWWW..',
      '..WKWKW..',
      'W.WWWWW.W',
      '.W.WwW.W.',
      '..W.W.W..',
      '...WWW...',
      '...WwW...',
      '...WWW...',
      '...WwW...',
      '....W....',
      '...WWW...',
      '..W....W.',
      '.WW....WW']] },
    witch: { c: { K: '#0c0614', E: '#ffb35c' }, f: [[
      '..........K.......',
      '.........KK.......',
      '........KKK.......',
      '......KKKKKKK.....',
      '........KKE.......',
      '.......KKKKK......',
      '....KKKKKKKK......',
      '..KKKKKKKKKKKKKKKK',
      'KKKK.KK.K.........',
      '.KK..K............']] },
    ghost2: { c: { W: '#f7f2ff', w: '#c9bde3', K: '#2a1840' }, f: [[
      '...WWW...',
      '..WWWWW..',
      '.WWKWKWW.',
      '.WWWWWWw.',
      'WWWWKWWWw',
      '.WWWWWWw.',
      '.WWWWWWw.',
      '.WWWWWWw.',
      '.W.WWW.w.',
      '.....W...']] },
    candycorn: { c: { W: '#fff7e6', O: '#ff8a1f', Y: '#ffd23f' }, f: [[
      '..W..',
      '.WWW.',
      '.OOO.',
      'OOOOO',
      'YYYYY',
      '.YYY.']] },
    snowman2: { c: { W: '#f7fbff', w: '#c7d6e8', K: '#1b1b2b', O: '#ff8a1f', R: '#d93b3b', N: '#7a4a21', G: '#2f9a52' }, f: [[
      '....WWW....',
      '..RWWWWWR..',
      '..RWKWKWR..',
      '...WWWOO...',
      '....WWW....',
      '..GGGGGGG..',
      'N..GWWWW..N',
      '.N.WWKWWW.N',
      '..NWWWWWWN.',
      '.WWWWKWWWWw',
      '.WWWWWWWWWw',
      '..WWWWWWww.',
      '...wwwww...']] },
    gingerbread: { c: { B: '#b5651d', b: '#7a4012', W: '#ffffff', R: '#e8413c' }, f: [[
      '...BBB...',
      '..BWBWB..',
      '..BBBBB..',
      '...BWB...',
      'BBBBBBBBB',
      'WBBBRBBBW',
      '...BBB...',
      '...BRB...',
      '..BBBBB..',
      '.BB...BB.',
      'BW.....WB']] },
    candycane: { c: { R: '#e8413c', W: '#ffffff' }, f: [[
      '.WRW.',
      'R...W',
      'W...R',
      'R....',
      'W....',
      'R....',
      'W....',
      'R....',
      'W....',
      'R....']] },
    reindeer: { c: { N: '#6e4a24', B: '#9a6a3a', b: '#7a5028', K: '#2b1a10', W: '#f7f2e8' }, f: [[
      '.N.N..........',
      '..NNN.........',
      '.N.N..........',
      '..BBB.........',
      '.BBKB.........',
      'KBBBB.........',
      '..BBBBBBBBBW..',
      '..BbBBBBBBBB..',
      '..BBBBBBBBB...',
      '..B.B....B.B..',
      '..b.b....b.b..',
      '..K.K....K.K..']] },
    sleigh: { c: { R: '#d93b3b', r: '#a82a2a', Y: '#f6c75a', W: '#ffffff', S: '#f2c09a', K: '#1b1b2b', N: '#8a6a4a', B: '#9a6a3a', b: '#2b1a10' }, f: [[
      '.....W.....................N.N',
      '....RRR.....................NN',
      '....SWS...NNN...............BB',
      '...RRRRR.NNNNN.............KBB',
      '...RWWWR.NNNNN....BBBBBBBBBBB.',
      'RRRRRRRRRRRRRRR..BBBBBBBBBBB..',
      '.rRRRRRRRRRRRR...B.B.....B.B..',
      '.YYYYYYYYYYYYYYYYb.b.....b.b..',
      'Y..............Y..............']] },
    gift3: { c: { G: '#2f9a52', g: '#1f6b3a', R: '#e8413c' }, f: [[
      '..R..R..',
      '...RR...',
      'GGGRRGGG',
      'GGGRRGGg',
      'RRRRRRRR',
      'GGGRRGGg',
      'gggRRggg']] },
    hatch: { c: { W: '#fffaf0', w: '#d9cfc0', Y: '#ffd84d', K: '#2b2b2b', O: '#ff9a1f' }, f: [[
      '..WWW...',
      '.WWWWW..',
      '.WWwWW..',
      'WWwWwWW.',
      'WWWWWWW.',
      'WWWWWWW.',
      'WWWWWWW.',
      '.WWWWW..',
      '..WWW...'], [
      '..YYY...',
      '.YYKYO..',
      '.YYYYY..',
      'WwWwWwW.',
      'WWWWWWW.',
      'WWWWWWW.',
      'WWWWWWW.',
      '.WWWWW..',
      '..WWW...']] },
    basket: { c: { N: '#a0703c', n: '#6e4a24', P: '#ffb3d1', B: '#a8d8ff', Y: '#ffe38a', L: '#d6b8ff' }, f: [[
      '...NNNNNN...',
      '..N......N..',
      '..N.PBYL.N..',
      '.NPPBBYYLLN.',
      'NNNNNNNNNNNN',
      'NnNnNnNnNnNN',
      '.NnNnNnNnNn.',
      '.NNNNNNNNNN.',
      '..nnnnnnnn..']] },
    lamb: { c: { W: '#f7f5f0', w: '#d6d1c6', K: '#3a3240', E: '#ffffff' }, f: [[
      '...WWWW.....',
      '.WWWWWWWW.KK',
      'WWWWWWWWWKKK',
      'WWWWWWWWWKEK',
      'WWWWWWWWWWKK',
      '.WWWWWWWWW..',
      '..WwwWWwwW..',
      '..K.K..K.K..',
      '..K.K..K.K..']] },
    burger: { c: { B: '#e0a458', b: '#b9813f', S: '#fff3c4', L: '#6cc070', C: '#ffd23f', M: '#6b3b23', T: '#ff5a5a' }, f: [[
      '...BBBBBB...',
      '.BBSBBBSBBB.',
      'BBBBBSBBBBBB',
      'LLLLLLLLLLLL',
      'TTCCCTTCCCTT',
      'MMMMMMMMMMMM',
      'MMMMMMMMMMMM',
      'bBBBBBBBBBBb',
      '.bbbbbbbbbb.']] },
    corn: { c: { Y: '#ffd23f', y: '#e0a000', G: '#6cc070', g: '#3f9a4a' }, f: [[
      'g..........',
      'GGYyYyYyYy.',
      'GgYyYyYyYyY',
      'GGyYyYyYyY.',
      'g..........']] },
    icecream: { c: { P: '#ffb3d1', W: '#fff3c4', R: '#e8413c', N: '#e8b26a', n: '#b9813f' }, f: [[
      '..R...',
      '.PPPP.',
      'PPPPPP',
      '.WWWW.',
      'WWWWWW',
      'NnNnNN',
      '.NnNn.',
      '.nNnN.',
      '..Nn..',
      '..nN..',
      '...N..']] },
    sparkler: { c: { G: '#9aa0ad', Y: '#ffd23f', W: '#ffffff', O: '#ffb347' }, f: [[
      'Y.W.Y..',
      '.WYW...',
      'WYWYW..',
      '.WYW...',
      'Y.G.Y..',
      '..G....',
      '..G....',
      '..G....',
      '..G....',
      '..G....'], [
      '.W.O.W.',
      'O.YWY..',
      '.YWYWO.',
      'W.YWY..',
      '.O.G.W.',
      '..G....',
      '..G....',
      '..G....',
      '..G....',
      '..G....']] },
  };

  // Fireworks in more than one colour: the same burst, its two colours swapped.
  const BURSTS = {
    gold: { A: '#ffd166', a: '#fff3c4' },
    red: { A: '#ff4d4d', a: '#ffc2c2' },
    blue: { A: '#6cb6ff', a: '#d6ecff' },
    white: { A: '#ffffff', a: '#cfe3ff' },
    green: { A: '#6be38a', a: '#d2f7dc' },
  };
  // Other colours for a picture's letters: a white pumpkin, a brown bunny, a blue scarf, a yellow tulip.
  const TINTS = {
    whitePumpkin: { O: '#f2efe6', o: '#c9c3b8', Y: '#ffe9a8', y: '#e0c070' },
    brownBunny: { W: '#c8a27a', P: '#f2b8a0' },
    blueScarf: { R: '#3b7bd9' },
    yellowTulip: { R: '#ffd23f', r: '#e0a000' },
  };

  /**
   * What each season puts where, on the main page and the 8-bit one alike.
   * top and bottom: the scenes above the header and at the end of the page (20
   * picture pixels high inside their frames): sky, floor and lights, and their
   * things. line: on the header's line (10 rows fit there). margins: on a wide
   * screen, left and right. flyers: across the whole page, now and then. snow.
   * A thing: s, its picture; x from the left (% of the width) or r from the
   * right, t from the top or b from the bottom (picture pixels, so it keeps its
   * place at 2 or 3 screen pixels a picture pixel); k, its size; tint, other
   * colours; flip, facing the other way; wide, only where the scene is 600px or
   * more; v, in a margin: top, middle or bottom; frames, seconds for its
   * pictures to run once; move: how it moves. Nothing moves when motion is
   * turned down.
   */
  const HALLOWEEN_LINE = [
    { s: 'pumpkin', r: 4, move: 'flicker' }, { s: 'candycorn', r: 18 }, { s: 'pumpkin', r: 25, move: 'flicker', delay: -2.1 },
    { s: 'ghost2', r: 39 }, { s: 'pumpkin', r: 50, tint: 'whitePumpkin' }, { s: 'candycorn', r: 61 },
  ];
  const CHRISTMAS = {
    line: [{ s: 'gift1', r: 4 }, { s: 'gift2', r: 14 }, { s: 'snowmini', r: 23 }, { s: 'candycane', r: 32 }, { s: 'gift3', r: 39 }, { s: 'snowmini', r: 49, tint: 'blueScarf' }],
    drift: true,
    margins: {
      left: [{ s: 'xtree', k: 6, v: 'bottom' }, { s: 'snowman', k: 5, v: 'middle' }, { s: 'candycane', k: 6, v: 'top' }],
      right: [{ s: 'snowman2', k: 6, v: 'bottom' }, { s: 'gingerbread', k: 6, v: 'middle' }, { s: 'xtree', k: 4, v: 'top' }],
    },
    flyers: [{ s: 'sleigh', move: 'fly', t: 10, dur: 40, delay: -12 }],
    snow: true,
  };
  const CHRISTMAS_BOTTOM = {
    sky: 'stars', floor: 'snowfloor',
    things: [
      { s: 'sleigh', move: 'fly', t: 1, dur: 22, delay: -6, wide: true },
      { s: 'xtree', x: 4, b: 3 }, { s: 'snowman', x: 12, b: 3 }, { s: 'snowman2', x: 20, b: 3, wide: true }, { s: 'snowmini', x: 27, b: 3 },
      { s: 'reindeer', x: 34, b: 3 }, { s: 'gingerbread', x: 44, b: 3, wide: true }, { s: 'gift3', x: 50, b: 3 }, { s: 'gift1', x: 55, b: 3, wide: true },
      { s: 'candycane', x: 61, b: 3 }, { s: 'xtree', x: 67, b: 3, wide: true }, { s: 'snowman', x: 75, b: 3, tint: 'blueScarf', wide: true },
      { s: 'reindeer', x: 83, b: 3, flip: true, wide: true }, { s: 'xtree', x: 91, b: 3 },
    ],
  };
  const SCENES = {
    halloween: {
      top: {
        ground3: true,
        things: [
          { s: 'moon', x: 3, t: 1 },
          { s: 'web', r: 0, t: 0 },
          { s: 'spider', r: 4, t: 8, move: 'dangle' },
          { s: 'ghost2', x: 30, t: 3, move: 'bob', delay: -1.2, wide: true },
          { s: 'ghost', x: 56, t: 1, move: 'bob' },
          { s: 'ghost2', x: 86, t: 2, move: 'bob', delay: -0.6, wide: true },
          { s: 'pumpkin', x: 8, b: 1, move: 'flicker' },
          { s: 'tomb', x: 17, b: 2 },
          { s: 'ghoul', x: 21, b: 0, frames: 1.6, wide: true },
          { s: 'pumpkin', x: 28, b: 1, move: 'flicker', delay: -2, wide: true },
          { s: 'tomb', x: 33, b: 2 },
          { s: 'skeleton', x: 38, b: 2, frames: 0.8, wide: true },
          { s: 'cat', x: 44, b: 3 },
          { s: 'pumpkin', x: 51, b: 1, move: 'flicker', delay: -1.4 },
          { s: 'candycorn', x: 56, b: 2, wide: true },
          { s: 'tomb', x: 60, b: 2, wide: true },
          { s: 'ghoul', x: 65, b: 0, frames: 1.6, delay: -0.7, wide: true },
          { s: 'deadtree', x: 72, b: 2 },
          { s: 'pumpkin', x: 80, b: 1, tint: 'whitePumpkin', wide: true },
          { s: 'tomb', x: 88, b: 2, wide: true },
          { s: 'bat', move: 'fly', t: 1, dur: 11, delay: -2 },
          { s: 'bat', move: 'fly', t: 7, dur: 15, delay: -9, reverse: true },
          { s: 'bat', move: 'fly', t: 4, dur: 13, delay: -5, wide: true },
          { s: 'bat', move: 'fly', t: 10, dur: 18, delay: -12, reverse: true, wide: true },
          { s: 'witch', move: 'fly', t: 2, dur: 26, delay: -16, wide: true },
        ],
      },
      bottom: {
        ground3: true,
        things: [
          { s: 'moon', x: 86, t: 1, wide: true },
          { s: 'bat', move: 'fly', t: 2, dur: 14, delay: -3 },
          { s: 'bat', move: 'fly', t: 8, dur: 19, delay: -11, reverse: true, wide: true },
          { s: 'ghost2', x: 47, t: 2, move: 'bob', delay: -0.9, wide: true },
          { s: 'tomb', x: 5, b: 2 }, { s: 'tomb', x: 13, b: 2, wide: true }, { s: 'ghoul', x: 19, b: 0, frames: 1.6 },
          { s: 'pumpkin', x: 28, b: 1, move: 'flicker' }, { s: 'skeleton', x: 35, b: 2, frames: 0.8 }, { s: 'tomb', x: 43, b: 2 },
          { s: 'ghoul', x: 52, b: 0, frames: 1.6, delay: -0.8, wide: true }, { s: 'pumpkin', x: 60, b: 1, move: 'flicker', delay: -1.7, wide: true },
          { s: 'cat', x: 66, b: 3, wide: true }, { s: 'deadtree', x: 73, b: 2 }, { s: 'pumpkin', x: 82, b: 1, tint: 'whitePumpkin', wide: true },
          { s: 'tomb', x: 91, b: 2 },
        ],
      },
      line: HALLOWEEN_LINE,
      margins: {
        left: [{ s: 'pumpkin', k: 6, v: 'bottom', move: 'flicker' }, { s: 'ghost', k: 5, v: 'middle', move: 'bob' }, { s: 'bat', k: 4, v: 'top', frames: 0.36 }],
        right: [{ s: 'ghost2', k: 6, v: 'bottom', move: 'bob', delay: -1 }, { s: 'skeleton', k: 5, v: 'middle', frames: 0.8 }, { s: 'pumpkin', k: 5, v: 'top', tint: 'whitePumpkin' }],
      },
      flyers: [
        { s: 'bat', move: 'fly', t: 18, dur: 24, delay: -4 },
        { s: 'bat', move: 'fly', t: 46, dur: 31, delay: -17, reverse: true },
        { s: 'bat', move: 'fly', t: 70, dur: 27, delay: -9, wide: true },
        { s: 'witch', move: 'fly', t: 30, dur: 48, delay: -30, wide: true },
      ],
    },
    christmas: Object.assign({
      top: {
        sky: 'stars', floor: 'snowfloor', lights: 'lights',
        things: [
          { s: 'snowman', x: 3, b: 3 }, { s: 'xtree', x: 10, b: 3, wide: true }, { s: 'gift1', x: 16, b: 3 },
          { s: 'snowman2', x: 21, b: 3, wide: true }, { s: 'reindeer', x: 29, b: 3, wide: true }, { s: 'xtree', x: 40, b: 3 },
          { s: 'gift2', x: 47, b: 3 }, { s: 'gingerbread', x: 52, b: 3, wide: true }, { s: 'candycane', x: 57, b: 3, wide: true },
          { s: 'snowman', x: 62, b: 3, tint: 'blueScarf', wide: true }, { s: 'gift3', x: 69, b: 3, wide: true }, { s: 'xtree', x: 76, b: 3 },
          { s: 'gift1', x: 84, b: 3 }, { s: 'snowman2', x: 90, b: 3 },
        ],
      },
      bottom: CHRISTMAS_BOTTOM,
    }, CHRISTMAS),
    newyear: Object.assign({
      top: {
        sky: 'stars', floor: 'snowfloor', lights: 'lights',
        things: [
          { s: 'burst', x: 18, t: 2, move: 'burst', color: 'gold', dur: 3.2, delay: -0.4 },
          { s: 'burst', x: 34, t: 3, move: 'burst', color: 'white', dur: 4.1, delay: -2.3 },
          { s: 'burst', x: 50, t: 1, move: 'burst', color: 'green', dur: 3.7, delay: -1.1 },
          { s: 'burst', x: 66, t: 2, move: 'burst', color: 'red', dur: 3.9, delay: -3.0, wide: true },
          { s: 'burst', x: 84, t: 1, move: 'burst', color: 'blue', dur: 3.5, delay: -1.8, wide: true },
          { s: 'snowman', x: 3, b: 3 }, { s: 'xtree', x: 26, b: 3, wide: true }, { s: 'gift1', x: 42, b: 3, wide: true },
          { s: 'snowman2', x: 58, b: 3, wide: true }, { s: 'xtree', x: 76, b: 3 }, { s: 'gift1', x: 92, b: 3 },
        ],
      },
      bottom: Object.assign({}, CHRISTMAS_BOTTOM, { things: [
        { s: 'burst', x: 20, t: 1, move: 'burst', color: 'gold', dur: 3.6, delay: -1.2 },
        { s: 'burst', x: 56, t: 2, move: 'burst', color: 'white', dur: 4.3, delay: -0.5, wide: true },
        { s: 'burst', x: 80, t: 0, move: 'burst', color: 'green', dur: 3.3, delay: -2.4 },
      ].concat(CHRISTMAS_BOTTOM.things.filter(t => t.s !== 'sleigh')) }),
    }, CHRISTMAS),
    easter: {
      top: {
        floor: 'grass',
        things: [
          { s: 'cloud', x: 6, t: 1 }, { s: 'cloud', x: 46, t: 3, wide: true }, { s: 'cloud', x: 74, t: 1 },
          { s: 'tulip', x: 4, b: 3 }, { s: 'egg1', x: 9, b: 2 }, { s: 'bunny', x: 14, b: 3, frames: 1.4 },
          { s: 'daisy', x: 22, b: 3, wide: true }, { s: 'egg2', x: 26, b: 2 }, { s: 'chick', x: 31, b: 3, frames: 1.1 },
          { s: 'hatch', x: 37, b: 2, frames: 3, wide: true }, { s: 'tulip', x: 42, b: 3, tint: 'yellowTulip', wide: true },
          { s: 'egg3', x: 47, b: 2 }, { s: 'lamb', x: 52, b: 3, wide: true }, { s: 'daisy', x: 60, b: 3 },
          { s: 'bunny', x: 65, b: 3, frames: 1.4, delay: -0.6, tint: 'brownBunny', wide: true }, { s: 'egg4', x: 72, b: 2 },
          { s: 'chick', x: 77, b: 3, frames: 1.1, delay: -0.4, wide: true }, { s: 'basket', x: 83, b: 3, wide: true },
          { s: 'tulip', x: 90, b: 3 }, { s: 'egg1', x: 95, b: 2, wide: true },
          { s: 'butterfly', move: 'flutter', t: 1, dur: 17, delay: -4 },
          { s: 'butterfly', move: 'flutter', t: 4, dur: 22, delay: -15, reverse: true },
          { s: 'butterfly', move: 'flutter', t: 2, dur: 19, delay: -9, wide: true },
        ],
      },
      bottom: {
        floor: 'grass',
        things: [
          { s: 'cloud', x: 20, t: 1 }, { s: 'cloud', x: 70, t: 2, wide: true },
          { s: 'butterfly', move: 'flutter', t: 2, dur: 20, delay: -7 },
          { s: 'bunny', x: 4, b: 3, frames: 1.4 }, { s: 'egg2', x: 12, b: 2 }, { s: 'egg4', x: 16, b: 2, wide: true },
          { s: 'lamb', x: 22, b: 3 }, { s: 'hatch', x: 32, b: 2, frames: 3 }, { s: 'chick', x: 37, b: 3, frames: 1.1 },
          { s: 'basket', x: 44, b: 3 }, { s: 'egg1', x: 52, b: 2, wide: true },
          { s: 'bunny', x: 58, b: 3, frames: 1.4, delay: -0.5, tint: 'brownBunny', wide: true }, { s: 'daisy', x: 66, b: 3 },
          { s: 'tulip', x: 70, b: 3, tint: 'yellowTulip', wide: true }, { s: 'egg3', x: 76, b: 2 }, { s: 'chick', x: 82, b: 3, frames: 1.1, delay: -0.3, wide: true },
          { s: 'bunny', x: 88, b: 3, frames: 1.4, delay: -0.9, flip: true }, { s: 'tulip', x: 95, b: 3 },
        ],
      },
      line: [{ s: 'egg2', r: 4 }, { s: 'egg1', r: 12 }, { s: 'tulip', r: 20 }, { s: 'egg3', r: 27 }, { s: 'daisy', r: 35 }, { s: 'bunnymini', move: 'patrol' }],
      margins: {
        left: [{ s: 'bunny', k: 6, v: 'bottom', frames: 1.4 }, { s: 'basket', k: 5, v: 'middle' }, { s: 'butterfly', k: 5, v: 'top', frames: 0.3 }],
        right: [{ s: 'chick', k: 8, v: 'bottom', frames: 1.1 }, { s: 'lamb', k: 5, v: 'middle' }, { s: 'egg2', k: 6, v: 'top' }],
      },
      flyers: [
        { s: 'butterfly', move: 'flutter', t: 22, dur: 34, delay: -8 },
        { s: 'butterfly', move: 'flutter', t: 52, dur: 41, delay: -25, reverse: true },
        { s: 'butterfly', move: 'flutter', t: 76, dur: 37, delay: -14, wide: true },
      ],
    },
    july4: {
      top: {
        sky: 'stars', floor: 'gingham',
        things: [
          { s: 'burst', x: 12, t: 0, move: 'burst', color: 'red', dur: 3.4, delay: -0.6 },
          { s: 'burst', x: 30, t: 2, move: 'burst', color: 'white', dur: 4.2, delay: -2.6 },
          { s: 'burst', x: 50, t: 1, move: 'burst', color: 'blue', dur: 3.8, delay: -1.5 },
          { s: 'burst', x: 66, t: 0, move: 'burst', color: 'gold', dur: 3.6, delay: -3.1, wide: true },
          { s: 'burst', x: 82, t: 2, move: 'burst', color: 'red', dur: 4.0, delay: -0.9, wide: true },
          { s: 'grill', x: 3, b: 4, move: 'smoke' }, { s: 'hotdog', x: 14, b: 4 }, { s: 'burger', x: 22, b: 4, wide: true },
          { s: 'melon', x: 29, b: 4 }, { s: 'corn', x: 36, b: 4, wide: true }, { s: 'icecream', x: 41, b: 4, wide: true },
          { s: 'sparkler', x: 46, b: 4, frames: 0.3 }, { s: 'hotdog', x: 54, b: 4, wide: true }, { s: 'melon', x: 62, b: 4, wide: true },
          { s: 'burger', x: 70, b: 4 }, { s: 'sparkler', x: 78, b: 4, frames: 0.3, delay: -0.15, wide: true },
          { s: 'icecream', x: 84, b: 4 }, { s: 'hotdog', x: 90, b: 4, wide: true },
        ],
      },
      bottom: {
        sky: 'stars', floor: 'gingham',
        things: [
          { s: 'burst', x: 10, t: 1, move: 'burst', color: 'gold', dur: 3.5, delay: -1.4 },
          { s: 'burst', x: 40, t: 0, move: 'burst', color: 'red', dur: 4.1, delay: -0.3, wide: true },
          { s: 'burst', x: 70, t: 2, move: 'burst', color: 'blue', dur: 3.7, delay: -2.2 },
          { s: 'burst', x: 88, t: 1, move: 'burst', color: 'white', dur: 3.9, delay: -3.3, wide: true },
          { s: 'grill', x: 4, b: 4, move: 'smoke' }, { s: 'hotdog', x: 16, b: 4 }, { s: 'burger', x: 24, b: 4 },
          { s: 'corn', x: 32, b: 4, wide: true }, { s: 'melon', x: 40, b: 4 }, { s: 'icecream', x: 48, b: 4 },
          { s: 'sparkler', x: 54, b: 4, frames: 0.3, wide: true }, { s: 'hotdog', x: 60, b: 4, wide: true },
          { s: 'burger', x: 68, b: 4, wide: true }, { s: 'melon', x: 76, b: 4 }, { s: 'sparkler', x: 84, b: 4, frames: 0.3, delay: -0.1 },
          { s: 'grill', x: 90, b: 4, move: 'smoke', wide: true },
        ],
      },
      line: [{ s: 'melon', r: 4 }, { s: 'hotdog', r: 18 }, { s: 'burger', r: 33 }, { s: 'corn', r: 47 }],
      margins: {
        left: [{ s: 'grill', k: 6, v: 'bottom', move: 'smoke' }, { s: 'hotdog', k: 5, v: 'middle' }, { s: 'sparkler', k: 5, v: 'top', frames: 0.3 }],
        right: [{ s: 'melon', k: 6, v: 'bottom' }, { s: 'icecream', k: 5, v: 'middle' }, { s: 'burger', k: 5, v: 'top' }],
      },
    },
  };

  const SEASONS = Object.keys(SCENES);

  /**
   * The scenes' height (their frame included; index.html keeps room for the
   * top one) and screen pixels a picture pixel: a phone, and anything 600px
   * wide or more.
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
   * letters (the fireworks, a white pumpkin).
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
    // The scenes: framed as the 8-bit page frames its boxes - or as the main page does, rounded.
    `.px-scene{position:absolute;top:12px;left:16px;right:16px;height:${SCENE_SIZE.wide.height}px;overflow:hidden;border:4px solid var(--px-line);box-shadow:4px 4px 0 var(--px-shadow);pointer-events:none;}`,
    `@media(max-width:599px){.px-scene{height:${SCENE_SIZE.narrow.height}px;}}`,
    ':root:not([data-theme="8bit"]) .px-scene{border:1px solid var(--border);border-radius:14px;box-shadow:none;}',
    '.px-scene.px-bottom{position:relative;top:auto;left:auto;right:auto;margin:0 0 16px;}',
    '.px-scene i,.px-scene b,.px-ground i,.px-ground b,.px-margins i,.px-margins b,.px-flyers i,.px-flyers b,.px-snow i{position:absolute;display:block;background-repeat:no-repeat;pointer-events:none;}',
    '.px-tile{left:0;right:0;background-repeat:repeat-x !important;}',
    '.px-sky{left:0;top:0;right:0;bottom:0;background-repeat:repeat !important;}',
    `.px-ground{position:absolute;right:0;bottom:0;width:50%;height:${GROUND.height}px;pointer-events:none;}`,
    '.px-margins{position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:0;display:none;}',
    '@media(min-width:1100px){.px-margins{display:block;}}',
    // Behind the page's boxes and words (the column is above it), so nothing crossing hides a word.
    '.px-flyers{position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:0;overflow:hidden;}',
    '.px-snow{position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:5;overflow:hidden;}',
    // Skies. Halloween's last band is the ground the silhouettes stand on (3 picture pixels).
    '.px-halloween{background:linear-gradient(#1d0f33 0 30%,#33154c 30% 48%,#561c54 48% 62%,#8a2a4b 62% 74%,#cc5a2c 74% calc(100% - var(--px-g)),#0c0614 calc(100% - var(--px-g)));}',
    '.px-christmas,.px-newyear{background:linear-gradient(#081629 0 45%,#0d2140 45% 75%,#12294d 75%);}',
    '.px-easter{background:linear-gradient(#bfe3ff 0 40%,#d6eeff 40% 72%,#e9f7ff 72%);}',
    '.px-july4{background:linear-gradient(#050f22 0 45%,#0a1a36 45% 75%,#0f2347 75%);}',
    '.px-thread{background:#b9aed0;}',
    '@keyframes px-fly{from{transform:translateX(-96px);}to{transform:translateX(100%);}}',
    '@keyframes px-flutter{0%{transform:translate(-24px,6px);}20%{transform:translate(20%,0);}40%{transform:translate(40%,9px);}60%{transform:translate(60%,2px);}80%{transform:translate(80%,8px);}100%{transform:translate(100%,3px);}}',
    '@keyframes px-bob{0%,100%{transform:translateY(0);}50%{transform:translateY(-4px);}}',
    '@keyframes px-dangle{0%,100%{transform:translateY(0);}50%{transform:translateY(8px);}}',
    '@keyframes px-hop{0%,100%{transform:translateY(0);}50%{transform:translateY(-2px);}}',
    '@keyframes px-rise{0%{transform:translateY(0);opacity:.9;}100%{transform:translateY(-18px);opacity:0;}}',
    '@keyframes px-face{0%,50%{transform:scaleX(-1);}50.01%,100%{transform:scaleX(1);}}',
    '@keyframes px-fall{0%{transform:translate(0,-16px);}25%{transform:translate(6px,25vh);}50%{transform:translate(0,50vh);}75%{transform:translate(-6px,75vh);}100%{transform:translate(0,104vh);}}',
    '@media (prefers-reduced-motion: reduce){.px-scene *,.px-ground *,.px-margins *{animation:none !important;}.px-snow,.px-flyers{display:none;}}',
    '@media print{.px-scene,.px-ground,.px-margins,.px-flyers,.px-snow{display:none;}}',
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
   * Draws a season into the page - the main page or the 8-bit one. doc: the
   * document; season: its name; opts.still: no motion; opts.width: the
   * window's width (the scenes' size, what fits, the snowflakes);
   * opts.random: Math.random or a stand-in. Returns the elements it added.
   */
  function build(doc, season, opts) {
    opts = opts || {};
    const plan = SCENES[season];
    if (!plan) return [];
    const random = opts.random || Math.random;
    const still = !!opts.still;
    const width = opts.width || 1024;
    const wide = width >= 600;
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
    /** A strip repeated along (a floor, the lights, the snow on the header's line). */
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
    const colorsOf = (it) => (it.color ? BURSTS[it.color] : it.tint ? TINTS[it.tint] : undefined);

    /** One thing, placed and moving as its plan says. top: in picture pixels, or a % of the window for a flyer. */
    const thing = (it, k, flyer) => {
      const name = it.s, { w, h, n } = size(name), delay = it.delay || 0;
      if (it.move === 'fly' || it.move === 'flutter') {
        // Across: a band as wide as its box moves, the sprite at its left end.
        const band = make('b');
        band.style.left = '0'; band.style.width = '100%'; band.style.height = `${h * k}px`;
        band.style.top = flyer ? `${it.t}%` : `${it.t * k}px`;
        // Still, they wait where they are instead.
        band.style.transform = `translateX(${it.reverse ? 70 : 30}%)`;
        anim(band, `px-${it.move} ${it.dur}s linear ${delay}s infinite${it.reverse ? ' reverse' : ''}`);
        const el = sprite(name, k, colorsOf(it));
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
        const el = sprite(name, k, colorsOf(it));
        anim(el, `px-f-${name}-${k} 0.7s steps(${n}) infinite, px-hop 0.7s steps(2) infinite`);
        face.appendChild(el);
        band.appendChild(face);
        return band;
      }
      if (it.move === 'burst') {
        const el = place(sprite(name, k, colorsOf(it), 2), it, k);   // still: the burst at its widest
        need(name, k);
        anim(el, `px-burst-${name}-${k} ${it.dur}s steps(1,end) ${delay}s infinite`);
        // Each time, somewhere else in the sky.
        if (!still && el.addEventListener) {
          el.addEventListener('animationiteration', () => {
            el.style.left = `${Math.round(8 + random() * 76)}%`;
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
      const el = place(sprite(name, k, colorsOf(it)), it, k);
      if (it.flip) el.style.transform = 'scaleX(-1)';
      const moves = [];
      if (it.move === 'bob') moves.push(`px-bob 2.4s steps(6) ${delay}s infinite`);
      if (it.move === 'flicker') { need(name, k); moves.push(`px-flick-${name}-${k} 3.1s steps(1,end) ${delay}s infinite`); }
      if (it.frames && n > 1) { need(name, k); moves.push(`px-f-${name}-${k} ${it.frames}s steps(${n}) ${delay}s infinite`); }
      if (moves.length) anim(el, moves.join(', '));
      return el;
    };

    /** A scene: its sky, floor and lights, and its things - those that fit at this width. */
    const scene = (part, cls) => {
      const k = (wide ? SCENE_SIZE.wide : SCENE_SIZE.narrow).k;
      const box = make('div', `px-scene${cls}px-${season}`);
      box.setAttribute('aria-hidden', 'true');
      if (part.ground3) box.style.setProperty('--px-g', `${3 * k}px`);
      if (part.sky) {
        const sky = sprite(part.sky, k);
        sky.className = 'px-sky';
        sky.style.width = ''; sky.style.height = '';
        box.appendChild(sky);
      }
      if (part.floor) {
        const floor = tile(part.floor, k, 'bottom');
        floor.style.height = `${size(part.floor).h * k}px`;
        box.appendChild(floor);
      }
      if (part.lights) {
        const lights = tile(part.lights, k, 'top');
        lights.style.height = `${size(part.lights).h * k}px`;
        need(part.lights, k);
        anim(lights, `px-tw-${part.lights}-${k} 1.6s linear infinite`);
        box.appendChild(lights);
      }
      for (const it of part.things) if (wide || !it.wide) box.appendChild(thing(it, k));
      return box;
    };

    const app = doc.getElementById('app');
    if (app && plan.top) {
      // Above the header, in the room index.html keeps for it.
      const top = scene(plan.top, ' ');
      app.insertBefore(top, app.firstChild);
      added.push(top);
    }
    if (app && plan.bottom) {
      // At the end of the page: after the disclaimer, or last.
      const bottom = scene(plan.bottom, ' px-bottom ');
      const after = doc.getElementById('site-disclaimer');
      if (after && after.parentNode) after.parentNode.insertBefore(bottom, after.nextSibling || null);
      else app.appendChild(bottom);
      added.push(bottom);
    }

    // Standing on the header's bottom line, in its padding, clear of its words.
    const header = doc.querySelector ? doc.querySelector('.header') : null;
    if (header && plan.line) {
      const k = GROUND.k;
      const ground = make('div', 'px-ground');
      ground.setAttribute('aria-hidden', 'true');
      if (plan.drift) {
        const drift = tile('snowfloor', k, 'bottom');
        drift.style.height = `${size('snowfloor').h * k}px`;
        ground.appendChild(drift);
      }
      for (const it of plan.line) ground.appendChild(thing(Object.assign({ b: 0 }, it), k));
      header.appendChild(ground);
      added.push(ground);
    }

    const body = doc.body;
    // On a wide screen, in the middle of each margin: one near the top, one halfway, one near the bottom.
    if (body && plan.margins) {
      const margins = make('div', 'px-margins');
      margins.setAttribute('aria-hidden', 'true');
      for (const side of ['left', 'right']) {
        for (const it of plan.margins[side] || []) {
          const k = it.k, { w, h } = size(it.s);
          const el = thing({ s: it.s, move: it.move, frames: it.frames, tint: it.tint, delay: it.delay }, k);
          if (it.v === 'bottom') el.style.bottom = '32px';
          else if (it.v === 'middle') el.style.top = `calc(50% - ${(h * k) / 2}px)`;
          else el.style.top = '96px';
          // The middle of a margin: a quarter of what the 900px column leaves.
          el.style[side] = `calc((100vw - 900px) / 4 - ${(w * k) / 2}px)`;
          margins.appendChild(el);
        }
      }
      body.appendChild(margins);
      added.push(margins);
    }

    // Across the whole page now and then (bats, butterflies, a sleigh), behind its boxes and words - not when motion is turned down.
    if (body && plan.flyers && !still) {
      const k = (wide ? SCENE_SIZE.wide : SCENE_SIZE.narrow).k;
      const flyers = make('div', 'px-flyers');
      flyers.setAttribute('aria-hidden', 'true');
      for (const it of plan.flyers) if (wide || !it.wide) flyers.appendChild(thing(it, k, true));
      body.appendChild(flyers);
      added.push(flyers);
    }

    // Snow over everything at Christmas and the New Year - none for visitors who turn motion down.
    if (body && plan.snow && !still) {
      const snow = make('div', 'px-snow');
      snow.setAttribute('aria-hidden', 'true');
      const count = wide ? 36 : 18;
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
    const all = doc.querySelectorAll ? doc.querySelectorAll('.px-scene,.px-ground,.px-margins,.px-flyers,.px-snow,#px-season-css') : [];
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
    const calm = media('(prefers-reduced-motion: reduce)'), wideScreen = media('(min-width: 600px)');
    const draw = () => {
      try {
        clear(doc);
        build(doc, season, { still: !!(calm && calm.matches), width: window.innerWidth });
      } catch (e) { /* decorations only */ }
    };
    for (const mq of [calm, wideScreen]) {
      try { if (mq && mq.addEventListener) mq.addEventListener('change', draw); } catch (e) { /* drawn once */ }
    }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', draw);
    else draw();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SPRITES, BURSTS, TINTS, SCENES, SEASONS, SCENE_SIZE, GROUND, size, svgUri, frameRules, build, clear };
  } else {
    start();
  }
})();
