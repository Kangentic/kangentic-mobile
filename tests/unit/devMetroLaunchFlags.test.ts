/**
 * scripts/dev.mjs's startMetro must never pass `--android` to `expo start`.
 *
 * That launcher enumerates adb devices ITSELF and refuses outright when ANY
 * attached device is unauthorized - even though the rig has already chosen
 * its own target and exported ANDROID_SERIAL. With a phone plugged in and its
 * USB-debugging prompt unanswered, every connected mode used to die as "This
 * computer is not authorized for developing on Device <serial>" followed by
 * `[rig] metro exited (1)`, taking the whole rig down with output that never
 * pointed at the phone. startMetro now starts the bundler alone and opens the
 * dev client itself once the "Waiting on http://" ready line appears.
 *
 * A static scan is the right enforcement here (same idiom as
 * rigProcessRegistry.test.ts's kill-target scan): the failure this guards is
 * a REINTRODUCED flag, not a runtime value, and no runtime test can catch a
 * future edit that quietly adds `--android` back. The scan is deliberately
 * scoped to the args CONSTRUCTION (the initializer and every `args.push`
 * call) rather than the whole function body, because the function's own
 * doc-comment names `expo start --android` in prose - a whole-body substring
 * check would fail on that comment forever, for the right code.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
const devRig = readFileSync(join(scriptsDir, 'dev.mjs'), 'utf8');

/**
 * Extracts a top-level function's source by brace-balance, starting at its
 * declaration. Skips past the PARAMETER LIST first (paren-balanced) before
 * looking for the body's opening brace, because a default-parameter object
 * literal (`extraEnv = {}`) introduces a `{` of its own before the real body
 * starts.
 */
function extractFunctionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`could not find "${declaration}" in dev.mjs`);
  const parametersStart = source.indexOf('(', start);
  let parenDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === '(') parenDepth += 1;
    else if (source[index] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        parametersEnd = index;
        break;
      }
    }
  }
  if (parametersEnd === -1) throw new Error(`unbalanced parameters extracting "${declaration}"`);
  const bodyStart = source.indexOf('{', parametersEnd);
  let braceDepth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') braceDepth += 1;
    else if (source[index] === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces extracting "${declaration}"`);
}

describe('scripts/dev.mjs startMetro never re-adds `expo start --android`', () => {
  const startMetroBody = extractFunctionBody(devRig, 'function startMetro(');

  it('is scanning a body that still builds the expo start args and opens the dev client itself (non-vacuity guard)', () => {
    // If this fails, the extraction broke (a rename or restructure moved the
    // logic) rather than the flag having actually come back - fix the scan,
    // not the source.
    expect(startMetroBody).toContain('pointDevClientAtMetro(serial)');
    const argsInit = startMetroBody.match(/const args = \[([^\]]*)\];/);
    expect(argsInit).not.toBeNull();
  });

  it('does not construct `expo start --android`', () => {
    const argsInit = startMetroBody.match(/const args = \[([^\]]*)\];/);
    expect(argsInit![1]).not.toContain('--android');

    const pushedFlags = [...startMetroBody.matchAll(/args\.push\('([^']*)'\)/g)].map((match) => match[1]);
    expect(pushedFlags).not.toContain('--android');
  });
});
