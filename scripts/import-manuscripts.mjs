#!/usr/bin/env node
/**
 * import-manuscripts.mjs
 *
 * Walks the manuscript library (this repo's nine numbered category folders)
 * and inserts each .md manuscript into the LiveWell database as a row in
 * 'posts', 'books', or 'resources' — with idempotent upserts on slug.
 *
 * IMPORTANT: This script is meant to live in (or be copied into) a working
 * checkout of the LiveWell website source. It imports './server/db.ts' and
 * './drizzle/schema.ts' the same way the existing add-content.mjs does.
 * Until the website repo is unarchived (or a new repo replaces it), this
 * script can't run end-to-end — but the logic, schema, and manifest are all
 * correct so you can drop it in once the runtime is available.
 *
 * Usage:
 *   1. Copy this file and `manifest.json` into the LiveWell website repo root.
 *   2. Set DATABASE_URL in your .env (same one the live site uses).
 *   3. Place the manuscripts repo (or a clone) at MANUSCRIPTS_DIR
 *      (default: ../james-bell-manuscripts, override with $MANUSCRIPTS_DIR).
 *   4. Run:  node import-manuscripts.mjs --dry-run     (preview, no writes)
 *            node import-manuscripts.mjs               (real import)
 *            node import-manuscripts.mjs --only=05_PCN (one folder)
 *
 * What gets created:
 *   - 01_Major_Books     -> books          (bookType: 'authored')
 *   - 02_Church_Governance_Series -> books (bookType: 'authored', sortOrder by Book##)
 *   - 03_Booklets        -> posts (format: 'book-chapter', topic: derived)
 *   - 04_HB_Series       -> posts (format: 'article',     topic: derived, audience: 'individuals')
 *   - 05_PCN             -> posts (format: 'article',     audience: 'pastors')
 *   - 06_FBC             -> resources (category: 'fbc')   *not published by default*
 *   - 07_ResourceWall    -> resources (category: 'reader-companion')
 *   - 08_Articles        -> posts (format: 'article')
 *   - 09_Other           -> SKIPPED by default (mixed/working content) unless --include-other
 *
 * Idempotency: each insert uses onDuplicateKeyUpdate on slug.
 * Slug strategy: lower-kebab from the cleaned title.
 *
 * Duplicates listed in the root README.md are filtered out (only the canonical
 * file is imported). See DUPES_TO_SKIP below.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './server/db.ts';
import { posts, books, resources } from './drizzle/schema.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANUSCRIPTS_DIR = process.env.MANUSCRIPTS_DIR
  || path.resolve(__dirname, '..', 'james-bell-manuscripts');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const INCLUDE_OTHER = args.has('--include-other');
const ONLY = [...args].find(a => a.startsWith('--only='))?.split('=')[1];

// Files marked as duplicates in the master README. Only the canonical version
// is imported.
const DUPES_TO_SKIP = new Set([
  '01_Major_Books/FULL_MANUSCRIPT.md',
  '01_Major_Books/Forming_Faith_in_Children_FULL.md',
  '01_Major_Books/When_God_Bless_America_Enhanced_Complete.md',
  '01_Major_Books/When_God_Bless_America_Replaces_Thy_Kingdom_Come_Complete (1).md',
  '01_Major_Books/What If Were Wrong.md', // canonical: ...Amazon KDP Edition.md
  '01_Major_Books/reliability-of-scripture_complete_2026-04-10_v1.md',
  '01_Major_Books/monster-in-the-mirror_complete-edit_2026-04-07_v1.md',
  // Cross-folder duplicates — keep canonical, skip the 09_Other / 08_Articles copy
  '09_Other/Monster-Mirror-Blog-Articles.md',
  '08_Articles/PCN_Articles_Library_Vol3.md',
  '08_Articles/ResourceWall_DeconstructionOfFaith.md',
  '08_Articles/ResourceWall_ReliabilityOfScripture.md',
  '09_Other/P2-01 What the Prosperity Gospel Gets Almost Right.md',
  '09_Other/P2-05 Cheap Grace vs Costly Grace - What Bonhoeffer Was Actually Saying.md',
  '09_Other/P2-06 The Kingdom of God Is Not the Same as America.md',
  '09_Other/P2-09 Lament Is a Spiritual Discipline We\u2019ve Almost Entirely Lost.md',
  '09_Other/P2-14 The Book of Job Is Not About Why God Allows Suffering.md',
  '09_Other/Monster-Mirror-Blog-Articles.md',
  '09_Other/FBC_SmallGroupLeadershipCurriculum_12Week.md',
  '09_Other/FBC_SmallGroupLeadershipTraining_12WeekCurriculum.md',
]);

// Topic mapping based on filename / title keywords — maps to schema enum:
// 'justice' | 'leadership' | 'spiritual-formation' | 'church-health'
// 'personal-growth' | 'pastoral-care'
function inferTopic(name) {
  const s = name.toLowerCase();
  if (/elder|deacon|govern|pastor|leader|ministry/.test(s)) return 'leadership';
  if (/marriage|family|children|parent|sex|men|women|honest/.test(s)) return 'personal-growth';
  if (/race|justice|border|stranger|america|political|kingdom|prophet/.test(s)) return 'justice';
  if (/mental|illness|suicide|abuse|suffer|grief|trauma|weight/.test(s)) return 'pastoral-care';
  if (/discipline|worship|hymn|membership|skeptic|deconstruction|reliability|believe/.test(s)) return 'church-health';
  return 'spiritual-formation';
}

function inferAudience(folder, name) {
  if (folder === '05_PCN' || /pastor|elder|leader/i.test(name)) return 'pastors';
  if (/marriage|spouse|honest/i.test(name)) return 'couples';
  if (/group|leader/i.test(name)) return 'church-leaders';
  return 'individuals';
}

function parseFrontMatter(text) {
  if (!text.startsWith('---')) return { fm: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { fm: {}, body: text };
  const raw = text.slice(3, end);
  const fm = {};
  raw.split(/\r?\n/).forEach(line => {
    const m = line.match(/^(\w+):\s*"?([^"]*?)"?\s*$/);
    if (m) fm[m[1]] = m[2].trim();
  });
  return { fm, body: text.slice(end + 4) };
}

function extractTitle(filePath, fm, body) {
  const fileName = path.basename(filePath, '.md');
  const generic = new Set([
    'THE HARD ISSUES SERIES', 'PASTORS CONNECTION NETWORK',
    'LIVEWELL BY JAMES BELL', 'FIRST BAPTIST CHURCH OF FENTON',
    'Table of Contents', 'Dedication', 'Introduction', 'SEO Package',
    '<table>', 'WHEN', 'JAMES C. BELL'
  ]);
  // First bold heading in body
  const lines = body.split(/\r?\n/);
  let firstBold = '';
  for (const l of lines) {
    const t = l.trim();
    if (!firstBold) {
      const bm = t.match(/^\*\*([^*]+)\*\*\s*$/);
      if (bm) { firstBold = bm[1]; break; }
    }
  }
  const candidates = [fm.title_guess, firstBold].filter(Boolean);
  let best = candidates.find(c => !generic.has(c) && c.length > 2);
  if (!best) {
    best = fileName
      .replace(/[_-]/g, ' ')
      .replace(/\.\d{4}-\d{2}-\d{2}.*$/, '')
      .replace(/\sv\d+.*$/, '')
      .replace(/_\d{4}-\d{2}-\d{2}.*$/, '')
      .replace(/^(Booklet|Book\d+|HB\d+|TD\d+|W\d+|M\d+|ME\d+|MH\d+|P2-?\d+|PCN_)\s*/i, '')
      .trim();
  }
  return titleCase(best);
}

function titleCase(s) {
  return s.replace(/\b(\w)(\w*)/g, (_, a, b) => a.toUpperCase() + b.toLowerCase())
    .replace(/\b(And|The|Of|In|A|For|To)\b/g, w => w.toLowerCase())
    .replace(/^./, c => c.toUpperCase());
}

function slugify(title) {
  return title.toLowerCase()
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 200);
}

function extractExcerpt(body) {
  const lines = body.split(/\r?\n/);
  for (const l of lines) {
    const t = l.trim();
    if (t.length > 60 && !t.startsWith('#') && !t.startsWith('---')
        && !t.startsWith('source_') && !t.startsWith('**') && !t.startsWith('*')) {
      return t.slice(0, 280);
    }
  }
  return '';
}

function readingTimeMinutes(wordCount) {
  return Math.max(1, Math.round(wordCount / 220));
}

const FOLDER_CONFIG = {
  '01_Major_Books': { table: 'books', bookType: 'authored', published: true },
  '02_Church_Governance_Series': { table: 'books', bookType: 'authored', published: true, sortByBookNum: true },
  '03_Booklets': { table: 'posts', format: 'book-chapter', published: true, audience: 'individuals' },
  '04_HB_Series': { table: 'posts', format: 'article', published: true, audience: 'individuals' },
  '05_PCN': { table: 'posts', format: 'article', published: true, audience: 'pastors' },
  '06_FBC': { table: 'resources', category: 'fbc', published: false },
  '07_ResourceWall': { table: 'resources', category: 'reader-companion', published: true },
  '08_Articles': { table: 'posts', format: 'article', published: true, audience: 'individuals' },
  '09_Other': { table: 'posts', format: 'article', published: false, audience: 'individuals' }, // skipped unless --include-other
};

async function processFile(db, folder, filePath, cfg) {
  const rel = path.relative(MANUSCRIPTS_DIR, filePath).replace(/\\/g, '/');
  if (DUPES_TO_SKIP.has(rel)) {
    console.log(`  │ SKIP (duplicate)  ${rel}`);
    return { skipped: 'duplicate' };
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const { fm, body } = parseFrontMatter(text);
  const title = extractTitle(filePath, fm, body);
  const slug = slugify(title);
  const excerpt = extractExcerpt(body);
  const wordCount = parseInt(fm.word_count) || body.split(/\s+/).length;
  const readTime = readingTimeMinutes(wordCount);

  const baseLog = `  │ ${cfg.table.padEnd(9)} ${slug.padEnd(60)} ${title}`;
  if (DRY_RUN) { console.log(baseLog + ' [dry-run]'); return { dryRun: true }; }

  if (cfg.table === 'books') {
    const sortOrder = cfg.sortByBookNum ? parseInt((path.basename(filePath).match(/Book(\d+)/) || [])[1] || '999') : 0;
    await db.insert(books).values({
      title, slug, author: 'James C. Bell',
      description: excerpt, sampleExcerpt: body.slice(0, 1500),
      bookType: cfg.bookType, sortOrder, published: cfg.published,
    }).onDuplicateKeyUpdate({ set: { title, description: excerpt, sampleExcerpt: body.slice(0, 1500), sortOrder, published: cfg.published } });
  } else if (cfg.table === 'posts') {
    const topic = inferTopic(title + ' ' + path.basename(filePath));
    const audience = cfg.audience || inferAudience(folder, title);
    await db.insert(posts).values({
      title, slug, body, excerpt,
      readTime: `${readTime} min`, readingTimeMinutes: readTime,
      published: cfg.published, format: cfg.format, topic, audience,
      contentType: 'general', difficulty: 'intermediate',
      publishedAt: cfg.published ? new Date() : null,
    }).onDuplicateKeyUpdate({ set: { title, body, excerpt, readTime: `${readTime} min`, readingTimeMinutes: readTime, published: cfg.published, format: cfg.format, topic } });
  } else if (cfg.table === 'resources') {
    await db.insert(resources).values({
      title, description: excerpt,
      category: cfg.category, fileType: 'markdown',
      url: `https://github.com/pastorjbell206-cloud/james-bell-manuscripts/blob/main/${encodeURI(rel)}`,
      published: cfg.published,
    }).onDuplicateKeyUpdate({ set: { title, description: excerpt, category: cfg.category, published: cfg.published } });
  }
  console.log(baseLog);
  return { ok: true };
}

async function main() {
  const db = DRY_RUN ? null : await getDb();
  if (!DRY_RUN && !db) { console.error('No DB available. Set DATABASE_URL.'); process.exit(1); }

  console.log(`Manuscripts: ${MANUSCRIPTS_DIR}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE IMPORT'}${INCLUDE_OTHER ? ' (incl. 09_Other)' : ''}`);

  const stats = { ok: 0, skipped: 0, dryRun: 0, errors: 0 };
  for (const folder of Object.keys(FOLDER_CONFIG)) {
    if (ONLY && ONLY !== folder) continue;
    if (folder === '09_Other' && !INCLUDE_OTHER && !ONLY) {
      console.log(`\n[skip] ${folder} — use --include-other to import`); continue;
    }
    const cfg = FOLDER_CONFIG[folder];
    const dir = path.join(MANUSCRIPTS_DIR, folder);
    if (!fs.existsSync(dir)) { console.log(`[miss] ${folder} — not found`); continue; }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md');
    console.log(`\n│ ${folder} (${files.length} files → ${cfg.table})`);
    for (const f of files) {
      try {
        const result = await processFile(db, folder, path.join(dir, f), cfg);
        if (result.skipped) stats.skipped++;
        else if (result.dryRun) stats.dryRun++;
        else stats.ok++;
      } catch (e) {
        console.error(`  │ ERR  ${f}: ${e.message}`); stats.errors++;
      }
    }
  }
  console.log(`\nDone. ok=${stats.ok} skipped=${stats.skipped} dryRun=${stats.dryRun} errors=${stats.errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
