#!/usr/bin/env node
/**
 * Fetch Robinhood's Crypto Trading API OpenAPI document.
 *
 * Robinhood serves its API reference as a client-rendered SPA and publishes no
 * spec URL: `/openapi.json` and friends all 404. The document is, however,
 * inlined as a `JSON.parse('...')` string literal inside the page's own
 * webpack chunk. This script locates that chunk and extracts it.
 *
 * The result is not vendored into this repo on purpose: it is Robinhood's
 * documentation, and a fetched copy is always current where a checked-in one
 * silently goes stale. Use it to diff the API when something changes.
 *
 *     node scripts/fetch-spec.mjs > robinhood-openapi.json
 *
 * Writes the spec to stdout and progress to stderr.
 */

import { runInNewContext } from 'node:vm';

const DOCS_URL = 'https://docs.robinhood.com/crypto/trading/';

/** Pull the `/_next/static/chunks/...` URLs a Next.js page loads. */
function chunkUrls(html, origin) {
  const urls = new Set();
  for (const match of html.matchAll(/["'](\/_next\/static\/[^"']+\.js)["']/g)) {
    urls.add(new URL(match[1], origin).href);
  }
  return [...urls];
}

/**
 * Extract the first `JSON.parse('...')` payload that looks like the OpenAPI
 * document. The literal is single-quoted with escaped inner quotes, so it is
 * recovered by evaluating it as a JSON string after re-escaping.
 */
function extractSpec(source) {
  const marker = 'JSON.parse(';
  let index = source.indexOf(marker);

  while (index !== -1) {
    const quoteStart = source.indexOf("'", index);
    if (quoteStart === -1) break;

    // Walk to the matching unescaped closing quote.
    let cursor = quoteStart + 1;
    while (cursor < source.length) {
      if (source[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (source[cursor] === "'") break;
      cursor += 1;
    }

    const literal = source.slice(quoteStart + 1, cursor);
    if (literal.includes('"openapi"')) {
      // Two layers of escaping: the JS string literal, then the JSON inside it.
      // Let the JS engine unwrap the first layer: hand-rolling that unescape
      // gets backslash sequences in the embedded code samples wrong. Evaluating
      // a bare string literal executes no code.
      const jsString = runInNewContext(`'${literal}'`);
      return JSON.parse(jsString);
    }

    index = source.indexOf(marker, cursor);
  }

  return null;
}

async function main() {
  process.stderr.write(`Fetching ${DOCS_URL}\n`);
  const html = await (await fetch(DOCS_URL)).text();

  const candidates = chunkUrls(html, DOCS_URL);
  process.stderr.write(`Found ${candidates.length} chunks; scanning for the spec\n`);

  for (const url of candidates) {
    const source = await (await fetch(url)).text();
    // Cheap pre-filter so we only parse the chunk that can plausibly hold it.
    if (!source.includes('"openapi"')) continue;

    const spec = extractSpec(source);
    if (spec) {
      process.stderr.write(`Extracted from ${url}\n`);
      process.stderr.write(`  title: ${spec.info?.title}\n`);
      process.stderr.write(`  paths: ${Object.keys(spec.paths ?? {}).length}\n`);
      process.stdout.write(JSON.stringify(spec, null, 2));
      return;
    }
  }

  process.stderr.write(
    'Could not locate the spec. Robinhood may have changed how the docs page bundles it.\n',
  );
  process.exit(1);
}

await main();
