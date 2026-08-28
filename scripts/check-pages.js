#!/usr/bin/env node
/**
 * check-pages.js — refuses to let a broken page reach the live site.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-26 a commit pasted JavaScript into admin.html using curly quotes
 * (‘ ’) instead of ASCII ones as string delimiters. That is a hard syntax error,
 * so the ENTIRE <script> block stopped parsing and the Studio Hub did nothing at
 * all — the access-code button was dead and Stefani could not see her diary.
 * Nothing noticed: the page still returned HTTP 200 and still looked right.
 *
 * It had happened once before (commit 3d2e0c6, "Fix smart quotes in JS") and came
 * straight back, because nothing on the way to the live site ever tried to parse
 * the code. This does.
 *
 * WHAT IT CHECKS, per .html file in the repo root:
 *   1. every inline <script> block actually compiles
 *   2. every <script type="application/ld+json"> block is valid JSON
 *      (broken schema silently costs Google rich results)
 *   3. no curly quote is being used as a string delimiter
 *      — a curly quote INSIDE text (isn’t, they’ll) is fine and is left alone
 *
 * USAGE
 *   node scripts/check-pages.js          # check every page
 *   node scripts/check-pages.js admin.html
 * Exit code 0 = safe to commit/push. Non-zero = do not ship it.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const LS = '‘';
const RS = '’';

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** Every <script> block, with the offset it starts at so we can report real line numbers. */
function scriptBlocks(html) {
  const out = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;              // external file, nothing inline to parse
    out.push({
      attrs,
      code: m[2],
      offset: m.index + m[0].indexOf(m[2]),
      json: /type\s*=\s*["'][^"']*json/i.test(attrs),
    });
  }
  return out;
}

/**
 * A curly quote is only a problem when it is acting as a string delimiter.
 * Inside words it is a real apostrophe and must be left as it is.
 */
function badQuotes(code, html, offset) {
  const hits = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c !== LS && c !== RS) continue;
    const prev = code[i - 1] || '';
    const next = code[i + 1] || '';
    const between = /[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next);   // isn’t, they’ll
    const escaped = prev === '\\';                                     // \’ inside a string
    if (c === RS && between && !escaped) continue;                     // genuine apostrophe
    hits.push({ char: c === LS ? 'left' : 'right', line: lineOf(html, offset + i) });
  }
  return hits;
}

function checkFile(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const html = fs.readFileSync(file, 'utf8');
  const problems = [];

  for (const b of scriptBlocks(html)) {
    const startLine = lineOf(html, b.offset);

    if (b.json) {
      try {
        JSON.parse(b.code);
      } catch (e) {
        problems.push(`line ${startLine}: JSON-LD block is not valid JSON — ${e.message}`);
      }
      continue;
    }

    // compile only; never run the page's code
    try {
      new vm.Script(b.code, { filename: rel });
    } catch (e) {
      // vm reports the line WITHIN the block - translate it back to a real file line
      const hit = String(e.stack || '').match(/:(\d+)\n/);
      const at = hit ? startLine + Number(hit[1]) - 1 : startLine;
      problems.push(`line ${at}: <script> does not compile — ${e.message}`);
    }

    for (const q of badQuotes(b.code, html, b.offset)) {
      problems.push(`line ${q.line}: ${q.char} curly quote used as a string delimiter — use ' instead`);
    }
  }

  return { rel, problems };
}

const args = process.argv.slice(2);
const files = (args.length ? args.map(a => path.resolve(ROOT, a))
  : fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).map(f => path.join(ROOT, f)))
  .filter(f => fs.existsSync(f));

let bad = 0;
for (const f of files) {
  const { rel, problems } = checkFile(f);
  if (problems.length) {
    bad++;
    console.log(`\n  ${rel}`);
    // One bad delimiter cascades into hundreds of identical complaints - show a few
    // of each kind plus the line range, so the report stays readable.
    const groups = new Map();
    for (const p of problems) {
      const kind = p.replace(/^line \d+: /, '');
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(Number(p.match(/^line (\d+)/)[1]));
    }
    for (const [kind, lines] of groups) {
      const shown = lines.slice(0, 3).join(', ');
      const more = lines.length > 3
        ? ' (+' + (lines.length - 3) + ' more, lines ' + Math.min(...lines) + '-' + Math.max(...lines) + ')'
        : '';
      console.log('    line ' + shown + more + ': ' + kind);
    }
  }
}

if (bad) {
  console.log(`\n${bad} page(s) would be broken on the live site. Fix before pushing.\n`);
  process.exit(1);
}
console.log(`checked ${files.length} page(s) — all inline scripts compile.`);
