// Static health check for the page: only things that must or must not be true of
// the file itself. Anything about rendering - a class with no rule, an i18n key
// that is missing, a value leaking as text - is harness-track.mjs's job, because
// it runs the real renderer and sees the actual markup.
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');

// The upstream project leaked its data vendor's name into the page at one point;
// this build must never ship it.
console.log('gmgn occurrences:', (html.match(/gmgn/gi) || []).length, '(expect 0)');

const sizes = [...html.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
console.log('min font-size:', Math.min(...sizes), '| declarations:', sizes.length, '(floor is 14)');

// The two panels are one board now, and the old panel has to be gone rather than
// hidden: a panel left in the markup with no renderer behind it is a page that
// looks half-built. The endpoint stays - only the drawing moved.
console.log('trackPanel:', html.includes('id="trackPanel"'),
  '| signalPanel:', html.includes('id="signalPanel"'),
  '| /api/signals:', html.includes('/api/signals'),
  '| renderSignals leftover:', html.includes('renderSignals'));

// Every dictionary entry must carry exactly six languages. A short one is not a
// crash - it is that locale quietly showing a raw key or another language.
// The split has to tolerate a newline between values: a long entry is wrapped
// across lines, and a split that only accepts `', '` reports every wrapped entry
// as a language short, which is how this line used to cry wolf.
const dictMatch = /const messages = (\{[\s\S]*?\n    \};)\n\n    let currentLocale/.exec(html);
if (!dictMatch) { console.log('DICTIONARY NOT FOUND'); process.exit(1); }
const entries = [...dictMatch[1].matchAll(/\n {6}(\w+): \[([^\]]*)\]/g)];
const bad = entries.map((m) => [m[1], m[2].split(/',\s*'|",\s*"/).length]).filter(([, n]) => n !== 6);
console.log('dictionary entries:', entries.length, '| not six languages:', bad.length ? JSON.stringify(bad) : 'none');

const failed = bad.length > 0 || html.includes('id="signalPanel"') || html.includes('renderSignals')
  || Math.min(...sizes) < 14 || /gmgn/i.test(html);
process.exit(failed ? 1 : 0);
