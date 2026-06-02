/**
 * fix-back-button.js
 *
 * Recursively scans *.html / *.htm files under public/, plus 404.html
 * and contact-us.html, and strips inline theme properties from every
 * <a class="project-back-button"> element, then adds aria-label
 * where missing.
 *
 * Idempotent – safe to re-run.
 *
 * Usage: node scripts/fix-back-button.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Theme props to remove from the inline style attribute
const THEME_PROPS = ['background', 'color', 'border', 'box-shadow'];

const EXCLUDED_CLASSES = ['back-home', 'back-home-btn', 'back-btn'];

// Collect all HTML files
function collectHtmlFiles() {
  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        /\.html?$/i.test(entry.name)
      ) {
        files.push(full);
      }
    }
  }

  walk(path.join(ROOT, 'public'));

  for (const extra of ['404.html', 'contact-us.html']) {
    const p = path.join(ROOT, extra);
    if (fs.existsSync(p)) files.push(p);
  }

  return files;
}

function hasExcludedClass(html) {
  // Check if the file uses any of the excluded class names on an anchor
  // that links to "/"
  const anchorRegex = /<a\s[^>]*href\s*=\s*["']\/["'][^>]*>/gi;
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    for (const cls of EXCLUDED_CLASSES) {
      const classRegex = new RegExp(`class\\s*=\\s*["'][^"']*\\b${cls}\\b[^"']*["']`, 'i');
      if (classRegex.test(match[0])) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Strip theme properties from the style attribute value.
 * Also removes any trailing semicolons + whitespace left behind.
 */
function stripThemeProps(styleValue) {
  let result = styleValue;

  // Remove each theme property and its value (including leading/trailing spaces)
  for (const prop of THEME_PROPS) {
    // Match property name, optional whitespace, colon, value, semicolon
    const regex = new RegExp(
      `(^|;\\s*)\\s*${prop}\\s*:\\s*[^;]+;\\s*`,
      'gi'
    );
    result = result.replace(regex, (match, prefix) => {
      // If the property was at the start, remove without leaving separator
      if (prefix === '') return '';
      // If preceded by a semicolon, keep the separator
      return prefix;
    });

    // Handle case where the property is at the very end (no trailing semicolon)
    const endRegex = new RegExp(
      `(^|;\\s*)\\s*${prop}\\s*:\\s*[^;]+\\s*$`,
      'gi'
    );
    result = result.replace(endRegex, (match, prefix) => {
      if (prefix === '') return '';
      return prefix;
    });
  }

  // Clean up empty segments and double semicolons
  result = result
    .replace(/;;+/g, ';')
    .replace(/;\s*;/g, ';')
    .replace(/^;/, '')
    .replace(/;\s*$/, '')
    .trim();

  return result;
}

/**
 * Given the full HTML content, return an object describing the changes:
 * { changed: boolean, newHtml: string, touchedAnchors: number }
 */
function processFile(html) {
  let changed = false;
  let touchedAnchors = 0;

  // Match <a ... class="project-back-button" ...> ... </a>
  // Capture groups: 1 = opening tag (<a ...>), 2 = inner content, 3 = closing tag (</a> or </a\s+>)
  const anchorRegex = /(<a\s[^>]*?class\s*=\s*"project-back-button"[^>]*?>)([\s\S]*?)(<\/a\s*>)/gi;

  const newHtml = html.replace(anchorRegex, (match, openTag, innerContent, closeTag) => {
    let modifiedOpen = openTag;
    let modifiedInner = innerContent;

    // ---- Handle style attribute ----
    const styleRegex = /\bstyle\s*=\s*"([^"]*?)"/i;
    const styleMatch = styleRegex.exec(openTag);
    let hasStyleChange = false;

    if (styleMatch) {
      const originalStyle = styleMatch[1];
      const strippedStyle = stripThemeProps(originalStyle);

      if (strippedStyle !== originalStyle) {
        hasStyleChange = true;
      }

      if (strippedStyle === '') {
        modifiedOpen = modifiedOpen.replace(/\s*\bstyle\s*=\s*"[^"]*?"\s*/i, '');
      } else {
        modifiedOpen = modifiedOpen.replace(styleRegex, `style="${strippedStyle}"`);
      }
    }

    // ---- Handle aria-label ----
    const hasAriaLabel = /\baria-label\s*=\s*"/i.test(openTag);
    if (!hasAriaLabel) {
      // Insert before the closing > of the opening tag
      modifiedOpen = modifiedOpen.replace(/\s*>$/, ' aria-label="Back to homepage">');
    }

    // ---- Handle arrow wrap ----
    // Wrap the leading "←" (or similar) in a <span class="back-arrow">
    const arrowMatch = modifiedInner.match(/^(\s*)(←|&#8592;|&larr;)/);
    if (arrowMatch && !/<span\s+class="back-arrow"/.test(modifiedInner)) {
      modifiedInner = modifiedInner.replace(
        /^(?:\s*)(←|&#8592;|&larr;)/,
        '<span class="back-arrow">$1</span>'
      );
    }

    const innerChanged = modifiedInner !== innerContent;
    const openChanged = modifiedOpen !== openTag;

    if (hasStyleChange || !hasAriaLabel || innerChanged) {
      touchedAnchors++;
    }

    changed = changed || hasStyleChange || !hasAriaLabel || innerChanged;

    // Only reconstruct if something actually changed
    if (openChanged || innerChanged) {
      return modifiedOpen + modifiedInner + closeTag;
    }
    return match;
  });

  return { changed, newHtml, touchedAnchors };
}

function main() {
  const files = collectHtmlFiles();
  let scanned = 0;
  let changed = 0;
  let totalTouched = 0;
  const skipped = [];

  for (const file of files) {
    scanned++;
    const html = fs.readFileSync(file, 'utf-8');

    // Skip files that use excluded classes
    if (hasExcludedClass(html)) {
      skipped.push(file);
      continue;
    }

    // Check if file has any project-back-button anchors at all
    if (!/class\s*=\s*"project-back-button"/i.test(html)) {
      continue;
    }

    const { changed: wasChanged, newHtml, touchedAnchors } = processFile(html);

    if (wasChanged) {
      fs.writeFileSync(file, newHtml, 'utf-8');
      changed++;
      totalTouched += touchedAnchors;
      console.log(`  CHANGED  ${path.relative(ROOT, file)} (${touchedAnchors} anchor(s))`);
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Files scanned : ${scanned}`);
  console.log(`  Files changed : ${changed}`);
  console.log(`  Anchors touched : ${totalTouched}`);
  if (skipped.length > 0) {
    console.log(`  Skipped (excluded class) : ${skipped.length}`);
  }
}

main();
