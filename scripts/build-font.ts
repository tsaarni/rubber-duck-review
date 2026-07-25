/**
 * Rubber Duck Icon Font Generator
 *
 * What this script does:
 * Converts vector SVG assets (media/duck.svg) into a custom monochrome WOFF icon font (media/duck.woff)
 * mapping the duck glyph to Unicode character \e900 (U+E900).
 *
 * Why this is needed:
 * VS Code status bar items use text string labels (e.g. `statusBarItem.text = "$(rubber-duck)"`).
 * Inside text strings, VS Code requires custom product icons contributed via package.json `contributes.icons`
 * to provide a WOFF font file (fontPath & fontCharacter). Raw SVG paths in `contributes.icons` work in menus
 * and sidebars, but fail to render inside status bar text labels.
 *
 * Running `pnpm run build:font` (hooked into `pnpm run compile`) automatically generates the font.
 */

import fs from 'node:fs';
import path from 'node:path';
import svg2ttf from 'svg2ttf';
import ttf2woff from 'ttf2woff';

const { SVGIcons2SVGFontStream } = require('svgicons2svgfont');

async function buildFont(): Promise<void> {
  const stream = new SVGIcons2SVGFontStream({
    fontName: 'RubberDuckFont',
    fontHeight: 1000,
    descent: 0,
    normalize: true,
  });

  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<void>((resolve) => stream.on('end', resolve));

  const glyph = fs.createReadStream(
    path.join(__dirname, '../media/duck.svg')
  ) as fs.ReadStream & {
    metadata: { unicode: string[]; name: string };
  };
  glyph.metadata = { unicode: ['\ue900'], name: 'rubber-duck' };

  stream.write(glyph);
  stream.end();

  await done;

  const svgFont = Buffer.concat(chunks).toString('utf8');
  const ttfFont = Buffer.from(svg2ttf(svgFont).buffer);
  const woffFont = Buffer.from(ttf2woff(ttfFont).buffer);

  const outPath = path.join(__dirname, '../media/duck.woff');
  fs.writeFileSync(outPath, woffFont);
  console.log(`Successfully generated font: ${outPath}`);
}

buildFont();
