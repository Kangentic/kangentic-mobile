/**
 * Guards the build workflows against the ways they can silently rot.
 *
 * The Android workflow builds with Gradle rather than `eas build`, so eas.json is
 * no longer read by the build tool itself. That is a deliberate trade (see the CI
 * builds section of docs/developer-guide.md), and these tests are what keeps it
 * honest: the workflow's profile list must stay equal to eas.json's, which is
 * the EAS profile anchor named in .claude/rules/docs-stay-in-sync.md.
 *
 * The release-gate groups cover the safety gates on the Play submit job and the
 * iOS upload step. Those are the difference between "a release needs a
 * deliberate decision" and "a release happens because someone clicked Run
 * workflow".
 *
 * The iOS group additionally locks two orderings and one logging rule that are
 * each load bearing and none of which any other check would catch.
 *
 * The R8 groups (build-android's mapping-file upload, ci.yml's gradle.properties
 * and Sentry Android Gradle Plugin checks, and build-ios's dSYM check) lock the
 * CI enforcement steps and workflow wiring that keep a minified release
 * symbolicatable. app.config.ts's own R8 flags are covered separately, in
 * tests/unit/appConfigBrand.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflowPath = `${repositoryRoot}.github/workflows/build-android.yml`;
const iosWorkflowPath = `${repositoryRoot}.github/workflows/build-ios.yml`;
const easProfileScript = `${repositoryRoot}scripts/easProfile.mjs`;
const androidAbisScript = `${repositoryRoot}scripts/androidAbis.mjs`;

const workflowSource = readFileSync(workflowPath, 'utf8');
const iosWorkflowSource = readFileSync(iosWorkflowPath, 'utf8');

function readIosScript(name: string): string {
  return readFileSync(`${repositoryRoot}.github/scripts/${name}`, 'utf8');
}

/**
 * The section of build-ios.yml belonging to one job. Ordering assertions need
 * this: `expo prebuild --platform ios` appears in both the simulator and the
 * device job, so a whole-file indexOf silently compares against the wrong one.
 */
function readIosJob(jobName: string): string {
  const start = iosWorkflowSource.indexOf(`\n  ${jobName}:\n`);
  expect(start).toBeGreaterThan(-1);
  const nextJob = iosWorkflowSource.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return nextJob === -1 ? iosWorkflowSource.slice(start) : iosWorkflowSource.slice(start, start + 1 + nextJob);
}

/**
 * The same text with every whole-line `#` comment removed.
 *
 * Needed because this repository explains its decisions IN the file, so a
 * comment routinely contains the exact string a test asserts is absent - or
 * still contains one a test asserts is present after the real setting has been
 * deleted. Both directions were hit while writing these: an assertion that
 * `EXCLUDED_ARCHS=x86_64` is passed to xcodebuild stayed green with the flag
 * removed, because the comment above it names the flag.
 */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

interface EasConfig {
  build: Record<string, { extends?: string; channel?: string; distribution?: string }>;
}

const easConfig = JSON.parse(readFileSync(`${repositoryRoot}eas.json`, 'utf8')) as EasConfig;

/**
 * Pull the `profile` dispatch input's choice list out of the workflow. Parsed
 * as text on purpose: a YAML dependency would be a new package in the lockfile
 * for one assertion.
 */
function readWorkflowProfileChoices(): string[] {
  const lines = workflowSource.split('\n');
  const profileKeyIndex = lines.findIndex((line) => line === '      profile:');
  expect(profileKeyIndex).toBeGreaterThan(-1);

  const optionsKeyIndex = lines.findIndex((line, index) => index > profileKeyIndex && line === '        options:');
  expect(optionsKeyIndex).toBeGreaterThan(-1);

  const choices: string[] = [];
  for (let index = optionsKeyIndex + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^ {10}- ([\w-]+)$/);
    if (!match) {
      break;
    }
    choices.push(match[1]);
  }
  return choices;
}

function runScript(scriptPath: string, scriptArguments: string[]): string {
  return execFileSync(process.execPath, [scriptPath, ...scriptArguments], {
    encoding: 'utf8',
    cwd: repositoryRoot,
  }).trim();
}

function runEasProfileScript(scriptArguments: string[]): string {
  return runScript(easProfileScript, scriptArguments);
}

describe('build-android workflow and eas.json parity', () => {
  it('offers exactly the build profiles eas.json declares', () => {
    // No extra selection modes: the "all" fan-out was removed 2026-08-26 as
    // never-exercised (it could not submit, and its one-element matrix
    // wrapped every real build in a misleading "Matrix:" group). A profile
    // choice is an eas.json profile, nothing else.
    const choices = readWorkflowProfileChoices();
    expect(choices.sort()).toEqual(Object.keys(easConfig.build).sort());
  });

  it('gives every eas.json profile a default ABI list', () => {
    // A profile with no ABI default would throw at build time, on the runner,
    // after npm ci and prebuild have already run.
    const profilesWithAbiDefaults = runScript(androidAbisScript, ['--profiles']).split('\n');
    expect(profilesWithAbiDefaults.sort()).toEqual(Object.keys(easConfig.build).sort());
  });

  it('gives the e2e profile an emulator-installable ABI', () => {
    // The Maestro paired suite runs on a standard emulator image, which is
    // x86_64. An arm64-only APK builds and uploads fine and then fails at
    // `adb install` with an unhelpful error.
    expect(runScript(androidAbisScript, ['e2e'])).toContain('x86_64');
  });

  it('builds every ABI for production, since Play splits per device', () => {
    const productionAbis = runScript(androidAbisScript, ['production']).split(',');
    expect(productionAbis.sort()).toEqual(['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']);
  });

  it('verifies the artifact ABIs rather than trusting the Gradle flag', () => {
    expect(workflowSource).toContain('verify-android-abis.sh');
  });

  it('sources the profile env from eas.json rather than duplicating it in YAML', () => {
    expect(workflowSource).toContain('scripts/easProfile.mjs');
    // If the flag were ever inlined into the workflow, eas.json would stop
    // being authoritative for it and the two could drift apart unnoticed.
    expect(workflowSource).not.toContain('EXPO_PUBLIC_KANGENTIC_E2E');
    expect(easConfig.build.e2e).toBeDefined();
  });

  it('generates the native project instead of expecting a committed one', () => {
    // .claude/rules/expo-cng.md: android/ is a prebuild artifact.
    expect(workflowSource).toContain('expo prebuild --platform android --no-install');
  });

  it('exports the profile env before prebuild, not just before Gradle', () => {
    // app.config.ts reads EXPO_PUBLIC_KANGENTIC_E2E at config-evaluation time
    // to set android usesCleartextTraffic, and that evaluation happens during
    // prebuild. GITHUB_ENV only affects LATER steps, so exporting after
    // prebuild would produce an e2e APK that builds green but ships without the
    // cleartext manifest entry, and the Maestro paired suite would then fail at
    // relay connect (code 1006) with nothing in the build log to explain it.
    const exportIndex = workflowSource.indexOf('Export the profile env from eas.json');
    const prebuildIndex = workflowSource.indexOf('expo prebuild --platform android');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(prebuildIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(prebuildIndex);
  });

  it('exports the Sentry env before prebuild, for the same GITHUB_ENV reason', () => {
    // app.config.ts reads SENTRY_AUTH_TOKEN at config-evaluation time to decide
    // whether to include the Sentry plugin at all. Exporting after prebuild
    // would produce a build that reports crashes but has no source maps
    // uploaded, so every stack trace arrives minified and useless - green
    // build, worthless symbolication.
    const exportIndex = workflowSource.indexOf('Export the Sentry build env');
    const prebuildIndex = workflowSource.indexOf('expo prebuild --platform android');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(prebuildIndex);
  });

  it('keeps the Sentry DSN out of the committed config, as a variable not a secret', () => {
    // The repo is public and the Sentry project is on the free tier (5k
    // errors/month). A DSN committed to eas.json or the workflow would route
    // every fork's crashes into this project's quota. That is the reason it is
    // injected rather than committed - NOT confidentiality: a DSN ships inside
    // the published app bundle and is write-only. So it is a repository
    // VARIABLE, which can be read back to verify which project is wired; a
    // secret cannot, and a mistyped one would be undetectable.
    expect(workflowSource).toContain('vars.SENTRY_DSN');
    expect(workflowSource).not.toContain('secrets.SENTRY_DSN');
    expect(workflowSource).not.toMatch(/https:\/\/[0-9a-f]+@[a-z0-9.]*ingest/);
    const easSource = readFileSync(`${repositoryRoot}eas.json`, 'utf8');
    expect(easSource).not.toContain('SENTRY');
  });

  it('masks the Sentry auth token but not the DSN', () => {
    // The token can upload releases, so it is masked. Masking the DSN would
    // cost the one diagnostic the log is good for - which project a build
    // reported to - and buy nothing, since the value ships in the bundle.
    expect(workflowSource).toContain('::add-mask::$SENTRY_AUTH_TOKEN');
    expect(workflowSource).not.toContain('::add-mask::$SENTRY_DSN');
  });

  it('exports the crash-test flag before prebuild, for the same GITHUB_ENV reason', () => {
    // EXPO_PUBLIC_KANGENTIC_CRASHTEST is inlined by Metro when the bundle is
    // built. Unlike SENTRY_AUTH_TOKEN, app.config.ts does NOT read this one
    // (nothing in it references CRASHTEST) - the ordering requirement comes
    // purely from the bundling step that prebuild sets up, so do not go
    // looking for a config-evaluation reference that does not exist.
    // Exporting after prebuild would ship a build where Settings never
    // reveals the crash-test rows.
    const exportIndex = workflowSource.indexOf('Export the crash-test flag');
    const prebuildIndex = workflowSource.indexOf('expo prebuild --platform android');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(prebuildIndex);
  });

  it('keeps the crash-test flag out of eas.json and off by default', () => {
    // Same fork-quota reasoning as the Sentry export: dispatch-only, never
    // committed, defaults to false so a store-track build never carries it.
    //
    // Parsed rather than substring-matched: `toContain('default: false')` is
    // green as long as ANY input in the file defaults to false, so a second
    // boolean input would let crash_test's default silently flip to true
    // while this still passed. A check that cannot fire is worse than none
    // (.claude/rules/crash-reporting-scope.md).
    const workflow = parseYaml(workflowSource) as {
      on: { workflow_dispatch: { inputs: Record<string, { default?: unknown }> } };
    };
    expect(workflow.on.workflow_dispatch.inputs.crash_test.default).toBe(false);
    const easSource = readFileSync(`${repositoryRoot}eas.json`, 'utf8');
    expect(easSource).not.toContain('CRASHTEST');
  });

  it('forces the crash-test flag off on a tag build regardless of a stale dispatch input', () => {
    expect(workflowSource).toContain("CRASH_TEST: ${{ github.event_name != 'push' && inputs.crash_test == true }}");
  });

  it('refuses a crash-test build that also asks for a store submission', () => {
    // The CRASH_TEST expression only excludes a `push` (tag) build, but a tag
    // is not this project's release path - CLAUDE.md documents a DISPATCH with
    // `-f submit_track=internal`. Without this, one dispatch carrying both
    // crash_test and a real submit_track would upload a build with a
    // Sentry.nativeCrash() button in Settings to a live Play track.
    const workflow = parseYaml(workflowSource) as {
      on: { workflow_dispatch: { inputs: Record<string, { default?: unknown }> } };
      jobs: Record<string, { if?: string; steps?: { name?: string; if?: string }[] }>;
    };

    // The refusal below compares against the literal 'none', so it only stays
    // a targeted guard while that is the default. If the default became ''
    // the condition would be true on every ordinary dispatch and refuse every
    // crash-test build - the affordance would silently stop existing.
    expect(workflow.on.workflow_dispatch.inputs.submit_track.default).toBe('none');

    const refusal = workflow.jobs.plan.steps?.find((step) =>
      step.name === 'Refuse a crash-test build that is also a store submission'
    );
    expect(refusal?.if).toBe("inputs.crash_test == true && inputs.submit_track != 'none'");

    // And the submit job itself will not run for a crash-test build even if
    // the refusal above were ever removed.
    expect(workflow.jobs['submit-play'].if).toContain('inputs.crash_test != true');
  });
});

describe('build-android release safety gates', () => {
  it('never submits to Play unless a track was explicitly chosen', () => {
    expect(workflowSource).toContain("inputs.submit_track != 'none'");
  });

  it('puts the submit job behind a protected environment', () => {
    expect(workflowSource).toContain('environment: google-play');
  });

  it('verifies the signature in both the build and the submit job', () => {
    // The submit job re-verifies what it downloaded rather than trusting a job
    // output from the build. That is both stronger and necessary: matrix job
    // outputs are not per-instance addressable, so a trusted output would be
    // whichever matrix leg happened to finish last.
    const occurrences = workflowSource.split('verify-android-signature.sh').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('checks the version code against Play before uploading', () => {
    expect(workflowSource).toContain('scripts/checkPlayVersionCode.mjs');
  });

  it('preflights the version code in the plan job, before anything is built', () => {
    // The submit job checks too, but it carries `environment: google-play` and
    // its check is a step INSIDE that job, so it runs after a ~25 minute build
    // AND after a human approval. On 2026-07-28 that ordering meant a spent
    // counter was only discovered once both had already been spent. iOS always
    // checked before its archive; this closes the asymmetry.
    const workflow = parseYaml(workflowSource) as {
      jobs: Record<
        string,
        { needs?: string | string[]; steps?: { name?: string; if?: string; run?: string }[] }
      >;
    };

    const preflight = workflow.jobs.plan.steps?.find(
      (step) => step.name === 'Check the version code is free on every track'
    );
    expect(preflight?.run).toContain('scripts/checkPlayVersionCode.mjs');
    expect(preflight?.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.submit_track != 'none'"
    );

    // The preflight only helps if nothing can build past a failing plan job.
    expect(workflow.jobs['build-android'].needs).toBe('plan');
  });

  it('still re-checks the version code in the submit job', () => {
    // Not redundant with the plan-job preflight. This one closes the window
    // between planning and submitting, in which a release cut from another
    // machine could take the number.
    const occurrences = workflowSource.split('scripts/checkPlayVersionCode.mjs').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('caps artifact retention so storage does not accrue', () => {
    expect(workflowSource).toMatch(/retention-days: \d+/);
  });
});

describe('build-android R8 mapping upload', () => {
  it('uploads the R8 mapping file only for a release build, not the debug fallback', () => {
    // `development` and the keystore-less fallback both build the debug
    // variant (see the plan step), where R8 never runs and no mapping can
    // exist. A release build that produced no mapping is a real break, so the
    // step is gated on the variant rather than left to `if-no-files-found:
    // ignore` alone to notice.
    const workflow = parseYaml(workflowSource) as {
      jobs: Record<
        string,
        { steps?: { name?: string; if?: string; with?: Record<string, unknown> }[] }
      >;
    };
    const uploadStep = workflow.jobs['build-android'].steps?.find(
      (step) => step.name === 'Upload the R8 mapping file'
    );
    expect(uploadStep?.if).toBe("steps.plan.outputs.variant == 'release'");
    expect(uploadStep?.with?.path).toBe('android/app/build/outputs/mapping/release/mapping.txt');
  });

  it('names the R8 mapping artifact so it can never be swept into the Play upload glob', () => {
    // submit-play downloads with `pattern: kangentic-<profile>-*` and hands
    // `artifact/*` straight to Play as releaseFiles (merge-multiple: true). The
    // real artifact always starts with "kangentic-", so a mapping artifact
    // named `<artifact-name>-mapping` would match that same glob and Play
    // would receive mapping.txt as if it were a release binary. The
    // "mapping-" prefix is what keeps the two artifact sets disjoint.
    const workflow = parseYaml(workflowSource) as {
      jobs: Record<string, { steps?: { name?: string; with?: Record<string, unknown> }[] } >;
    };
    const uploadStep = workflow.jobs['build-android'].steps?.find(
      (step) => step.name === 'Upload the R8 mapping file'
    );
    const downloadStep = workflow.jobs['submit-play'].steps?.find(
      (step) => typeof step.with?.pattern === 'string'
    );
    expect(uploadStep?.with?.name).toBe('mapping-${{ steps.name.outputs.artifact-name }}');
    expect(downloadStep?.with?.pattern).toBe('kangentic-${{ inputs.profile }}-*');
  });
});

describe('build-ios workflow', () => {
  it('keeps the unsigned simulator check as its own job', () => {
    // Not a matrix dimension of the signed build. The simulator check needs no
    // Apple account and is the only iOS signal available when signing material
    // is missing or expired, so a signing problem must not be able to take it
    // down with it.
    expect(iosWorkflowSource).toMatch(/^ {2}simulator:$/m);
    expect(iosWorkflowSource).toMatch(/^ {2}device:$/m);
  });

  it('generates the native project instead of expecting a committed one', () => {
    // .claude/rules/expo-cng.md: ios/ is a prebuild artifact.
    expect(iosWorkflowSource).toContain('expo prebuild --platform ios --no-install');
  });

  it('resolves the scheme through the shared script in both jobs', () => {
    // Taking schemes[0] from `xcodebuild -list` once built a CocoaPods scheme
    // and reported success without compiling any app code. Both jobs must use
    // the same resolution so they cannot disagree about what they build.
    const occurrences = iosWorkflowSource.split('resolve-ios-scheme.sh').length - 1;
    expect(occurrences).toBe(2);
  });

  it('installs pods before anything reads the workspace', () => {
    // The .xcworkspace is a CocoaPods artifact and does not exist until
    // pod install completes, so resolving the scheme first finds nothing.
    const podInstallIndex = iosWorkflowSource.indexOf('working-directory: ios');
    const resolveIndex = iosWorkflowSource.indexOf('resolve-ios-scheme.sh');
    expect(podInstallIndex).toBeGreaterThan(-1);
    expect(podInstallIndex).toBeLessThan(resolveIndex);
  });

  it('preflights the build number before spending an archive', () => {
    // A duplicate build number is rejected by App Store Connect, and finding
    // that out after a 30 minute archive is the Android versionCode lesson
    // repeated on a slower platform.
    const preflightIndex = iosWorkflowSource.indexOf('scripts/checkAppStoreBuild.mjs');
    const archiveIndex = iosWorkflowSource.indexOf('xcodebuild archive');
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(archiveIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeLessThan(archiveIndex);
  });

  it('verifies the .ipa signature in both the build and the submit job', () => {
    // The submit job re-verifies what it downloaded rather than trusting the
    // build job. Same reasoning as the Android submit path, which caught a bad
    // artifact twice.
    const occurrences = iosWorkflowSource.split('verify-ios-signature.sh').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);

    const verifyIndex = iosWorkflowSource.indexOf('verify-ios-signature.sh');
    const uploadIndex = iosWorkflowSource.indexOf('upload-ios-testflight.sh');
    expect(uploadIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeLessThan(uploadIndex);
  });

  it('stores the artifact before attempting the upload', () => {
    // So an Apple-side failure leaves a verified .ipa that can be retried by
    // re-running the submit job alone. Not hypothetical: the first attempt to
    // submit this app hit an App Store Connect outage.
    //
    // Matched WITHOUT the version pin. This assertion used to search for
    // `actions/upload-artifact@v4` and broke the moment the action was bumped,
    // reporting "expected -1 to be greater than -1" - which reads like the
    // upload step vanished rather than like a version changed. The ordering is
    // what this test is about; the version is somebody else's business.
    const artifactIndex = iosWorkflowSource.search(/actions\/upload-artifact@v\d+/);
    const uploadIndex = iosWorkflowSource.indexOf('upload-ios-testflight.sh');
    expect(artifactIndex).toBeGreaterThan(-1);
    expect(artifactIndex).toBeLessThan(uploadIndex);
  });

  it('never uploads to Apple unless the dispatch asked for it', () => {
    // Asserted against the submit job's condition rather than a whole-file literal,
    // so tightening the condition (as the schedule trigger required) does not read
    // as a regression.
    expect(readIosJob('submit-testflight')).toContain("inputs.submit == 'testflight'");
  });

  it('puts the upload behind a protected environment, like the Play submit', () => {
    // An upload reaches people outside this machine, so it takes a human
    // approval rather than a dispatch input alone.
    expect(iosWorkflowSource).toContain('environment: app-store-connect');
    expect(iosWorkflowSource).toMatch(/^ {2}submit-testflight:$/m);
  });

  it('uploads from a macOS runner, since altool is the uploader', () => {
    // A cheaper ubuntu runner has no xcrun, and the failure would be an opaque
    // "command not found" after the artifact download.
    const submitJobIndex = iosWorkflowSource.indexOf('submit-testflight:');
    const submitJob = iosWorkflowSource.slice(submitJobIndex);
    expect(submitJob).toContain('runs-on: macos-latest');
  });

  it('derives the team id and profile from the profile, never a literal', () => {
    // The Apple team name is a personal name on an individual account
    // (.claude/rules/no-personal-info.md), and the EAS-issued profile name
    // embeds a timestamp that changes on every reissue, so a literal would both
    // leak and rot.
    expect(iosWorkflowSource).toContain('steps.signing.outputs.team-id');
    expect(iosWorkflowSource).toContain('steps.signing.outputs.profile-uuid');
    expect(iosWorkflowSource).not.toMatch(/DEVELOPMENT_TEAM=["']?[A-Z0-9]{10}["']?/);
  });

  it('keeps signing material out of a public log', () => {
    // This repository is public, so Actions logs are public. `codesign -dvv` and
    // `security find-identity` both print the certificate common name, which is
    // a person's legal name on an individual Apple Developer account. Both
    // scripts must capture that output and match against it, never cat it.
    for (const scriptName of ['install-ios-signing.sh', 'verify-ios-signature.sh']) {
      const source = readIosScript(scriptName);
      expect(source).toContain('no-personal-info.md');
      expect(source).not.toMatch(/^\s*(cat|echo)\s+"?\$(identities|signing_info)/m);
    }
  });

  it('accepts both App Store certificate types', () => {
    // Apple issues two and has retired neither: the newer unified "Apple
    // Distribution" and the older iOS-only "iPhone Distribution", which is what
    // `eas credentials` actually issues. Matching only the newer name rejected a
    // perfectly good certificate on the first real run.
    for (const scriptName of ['install-ios-signing.sh', 'verify-ios-signature.sh']) {
      const source = readIosScript(scriptName);
      expect(source).toContain('iPhone Distribution');
      expect(source).toContain('Apple Distribution');
    }
  });

  it('signs against the certificate SHA-1, not its name', () => {
    // Sidesteps the two-names problem entirely, and unlike the common name a
    // hash is not a person's legal name in a public log.
    expect(iosWorkflowSource).toContain('steps.signing.outputs.signing-identity');
    expect(readIosScript('export-ios-ipa.sh')).toContain('<string>$SIGNING_IDENTITY</string>');
  });

  it('scopes signing to the app target instead of the xcodebuild command line', () => {
    // Command-line build settings apply to EVERY target, and one that produces
    // no signed bundle rejects a provisioning profile outright. The first signed
    // archive died on a Swift Package target for exactly this reason.
    expect(iosWorkflowSource).not.toMatch(/xcodebuild archive[\s\S]{0,900}PROVISIONING_PROFILE_SPECIFIER=/);
    expect(iosWorkflowSource).not.toMatch(/xcodebuild archive[\s\S]{0,900}CODE_SIGN_STYLE=/);
    expect(iosWorkflowSource).toContain('KANGENTIC_IOS_PROFILE_UUID');
  });

  it('exports the signing inputs before prebuild, not just before the archive', () => {
    // withIosManualSigning runs during prebuild, and GITHUB_ENV only affects
    // LATER steps, so exporting late leaves the generated project on automatic
    // signing. Identical in shape to the eas.json env ordering on Android, and
    // identically silent when wrong.
    const deviceJob = readIosJob('device');
    const exportIndex = deviceJob.indexOf('Export the signing inputs for the config plugin');
    const prebuildIndex = deviceJob.indexOf('expo prebuild --platform ios');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(prebuildIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(prebuildIndex);
  });

  it('sources the profile env from eas.json, like the Android build does', () => {
    // Without this, an EXPO_PUBLIC_* value added to an eas.json profile reaches an
    // Android build and silently not an iOS one. Nobody notices until a feature
    // flag is inexplicably off on one platform.
    const deviceJob = readIosJob('device');
    const exportIndex = deviceJob.indexOf('scripts/easProfile.mjs');
    const prebuildIndex = deviceJob.indexOf('expo prebuild --platform ios');
    expect(exportIndex).toBeGreaterThan(-1);
    // Same ordering requirement as Android: app.config.ts reads EXPO_PUBLIC_* at
    // config-evaluation time, which happens during prebuild.
    expect(exportIndex).toBeLessThan(prebuildIndex);
  });

  it('exports the Sentry env before prebuild on iOS too', () => {
    // Android and iOS drifting apart on a build-time value is a documented
    // failure mode in this workflow pair (see the eas.json case above).
    const deviceJob = readIosJob('device');
    const exportIndex = deviceJob.indexOf('Export the Sentry build env');
    const prebuildIndex = deviceJob.indexOf('expo prebuild --platform ios');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(prebuildIndex);
  });

  it('exports the shared Keychain group before the archive bundles JS', () => {
    // src/notifications/sharedKeychain.ts reads
    // EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP at BUNDLE time (Metro inlines
    // it), unlike the three KANGENTIC_IOS_* exports alongside it in the same
    // step, which prebuild reads. Both need it before `xcodebuild archive`,
    // which is what actually invokes the "Bundle React Native code and
    // images" phase. If this one line moved to a later step, the shipped
    // bundle would carry no access group: the app would write the push key
    // into its own private Keychain group, the correctly-entitled extension
    // would find nothing there, and every push would degrade to the generic
    // placeholder - with the archive, signing, and every other check green.
    const deviceJob = readIosJob('device');
    const exportIndex = deviceJob.indexOf('EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP=$KEYCHAIN_ACCESS_GROUP');
    const archiveIndex = deviceJob.indexOf('xcodebuild archive');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(archiveIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(archiveIndex);
  });

  it('gates native config on BOTH platforms, not just Android', () => {
    // Prebuilding only Android is what let a broken config-plugin import reach an
    // iOS build while every PR check stayed green.
    const ciSource = readFileSync(`${repositoryRoot}.github/workflows/ci.yml`, 'utf8');
    expect(ciSource).toContain('expo prebuild --platform android');
    expect(ciSource).toContain('expo prebuild --platform ios');
  });

  it('surfaces the generated iOS privacy manifest as an artifact, and fails rather than warns if it is missing', () => {
    // PrivacyInfo.xcprivacy is a prebuild artifact, so this upload is the only
    // way to read what the app actually declares to Apple without a signed
    // build. `if-no-files-found: error` is the load-bearing half: downgraded to
    // `warn`, a manifest that stopped generating would leave the job green and
    // the declaration unverifiable, which is the exact failure the step exists
    // to catch. The glob matches ios/<projectName>/, which is ios/Kangentic/
    // for `name: 'Kangentic'` in app.config.ts.
    const ciSource = readFileSync(`${repositoryRoot}.github/workflows/ci.yml`, 'utf8');
    expect(ciSource).toContain('name: ios-privacy-manifest');
    expect(ciSource).toContain('path: ios/*/PrivacyInfo.xcprivacy');
    expect(ciSource).toContain('if-no-files-found: error');
  });

  it('asserts the app target actually got manual signing', () => {
    // The plugin is inert without its environment variables, and a silently
    // unsigned archive is the failure mode this workflow exists to prevent.
    const deviceJob = readIosJob('device');
    const assertIndex = deviceJob.indexOf('-showBuildSettings');
    const archiveIndex = deviceJob.indexOf('xcodebuild archive');
    expect(assertIndex).toBeGreaterThan(-1);
    expect(archiveIndex).toBeGreaterThan(-1);
    expect(assertIndex).toBeLessThan(archiveIndex);
  });

  it('confirms the Release configuration emits dSYMs, reusing the signing settings dump', () => {
    // The Sentry plugin's Xcode upload phase is asserted to EXIST by ci.yml,
    // but nothing else asserts the archive actually feeds it - an upload phase
    // with no dSYMs to upload fails silently, leaving every native iOS frame
    // unsymbolicated with every gate green.
    const deviceJob = readIosJob('device');
    const settingsDumpIndex = deviceJob.indexOf('-showBuildSettings');
    const dsymCheckIndex = deviceJob.indexOf('Verify the Release configuration emits dSYMs');
    const archiveIndex = deviceJob.indexOf('xcodebuild archive');
    expect(settingsDumpIndex).toBeGreaterThan(-1);
    expect(dsymCheckIndex).toBeGreaterThan(-1);
    expect(archiveIndex).toBeGreaterThan(-1);
    // Reuses the settings file the signing check already wrote, rather than a
    // second xcodebuild invocation, so the dump must precede this check.
    expect(settingsDumpIndex).toBeLessThan(dsymCheckIndex);
    expect(dsymCheckIndex).toBeLessThan(archiveIndex);

    const workflow = parseYaml(iosWorkflowSource) as {
      jobs: Record<string, { steps?: { name?: string; run?: string }[] }>;
    };
    const dsymStep = workflow.jobs.device.steps?.find(
      (step) => step.name === 'Verify the Release configuration emits dSYMs'
    );
    expect(dsymStep?.run).toContain('DEBUG_INFORMATION_FORMAT = dwarf-with-dsym');
    // Reuses the settings dump rather than a second xcodebuild invocation.
    expect(dsymStep?.run).not.toContain('xcodebuild');
  });

  it('fails a build whose entitlements lost push', () => {
    // A re-sign that drops aps-environment yields an app that installs,
    // launches, and silently never receives a notification. Push is the reason
    // this app exists, so this is fatal rather than a warning.
    const verifySource = readIosScript('verify-ios-signature.sh');
    expect(verifySource).toContain('aps-environment');
    expect(verifySource).toContain('could not receive push');
  });

  it('supports both App Store Connect auth mechanisms', () => {
    // An ASC API key is preferred, but minting one needs App Store Connect's
    // Users and Access page, which is exactly what fails during an ASC
    // incident. An app-specific password comes from appleid.apple.com instead.
    const uploadSource = readIosScript('upload-ios-testflight.sh');
    expect(uploadSource).toContain('--apiKey');
    expect(uploadSource).toContain('--apiIssuer');
    expect(uploadSource).toContain('--username');
  });

  it('caps artifact retention so storage does not accrue', () => {
    expect(iosWorkflowSource).toMatch(/retention-days: \d+/);
  });

  it('never signs or uploads on the weekly schedule', () => {
    // The trap: `inputs` are all empty on a schedule, so `inputs.target != 'device'`
    // and `inputs.target != 'simulator'` are BOTH true on a cron run. Left to input
    // defaults, the drift check would quietly fire a signed device build every
    // Monday, and with submit wired it could have uploaded one.
    expect(iosWorkflowSource).toContain('schedule:');
    expect(readIosJob('device')).toContain("github.event_name != 'schedule'");
    expect(readIosJob('submit-testflight')).toContain("github.event_name != 'schedule'");
    // And the cheap check must still run, or the schedule detects nothing.
    expect(readIosJob('simulator')).toContain("github.event_name == 'schedule'");
  });
});

/**
 * The iOS crash-test probe: `build-ios.yml -f crash_test=true` builds a
 * Release simulator app that carries the DSN and the crash-test flag, drives
 * the Settings crash rows with Maestro, relaunches after each crash so the
 * stored envelopes ship, and uploads the evidence. It exists because the
 * Sentry `mobile` project had never received an event from ANY iOS build
 * (task #67), and nothing short of a delivered event distinguishes "iOS is
 * stable" from "iOS reporting is dead".
 *
 * Every assertion here targets a step or expression that did not exist before
 * the probe was added, so each was red against the previous workflow.
 */
describe('build-ios crash-test probe', () => {
  interface IosWorkflowStep {
    name?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  }
  interface IosWorkflowShape {
    on: { workflow_dispatch: { inputs: Record<string, { type?: string; default?: unknown }> } };
    jobs: Record<string, { if?: string; env?: Record<string, string>; steps?: IosWorkflowStep[] }>;
  }
  const iosWorkflow = parseYaml(iosWorkflowSource) as IosWorkflowShape;

  function requireStep(jobName: string, stepName: string): IosWorkflowStep {
    const step = iosWorkflow.jobs[jobName]?.steps?.find((candidate) => candidate.name === stepName);
    expect(step, `build-ios.yml job "${jobName}" has no step named "${stepName}"`).toBeDefined();
    return step ?? {};
  }

  it('exports the Sentry env before prebuild in the simulator job too', () => {
    // Same GITHUB_ENV ordering as the device job: app.config.ts reads
    // SENTRY_AUTH_TOKEN at config-evaluation time to include the plugin that
    // uploads source maps and dSYMs, and the DSN is inlined by the bundling
    // phase prebuild sets up. Exported late, the crash arrives unsymbolicated
    // or not at all, with every step green.
    const simulatorJob = readIosJob('simulator');
    const exportIndex = simulatorJob.indexOf('Export the Sentry build env');
    const prebuildIndex = simulatorJob.indexOf('expo prebuild --platform ios');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(prebuildIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(prebuildIndex);
  });

  it('exports the crash-test flag before prebuild on iOS, and defaults it off', () => {
    const simulatorJob = readIosJob('simulator');
    const exportIndex = simulatorJob.indexOf('Export the crash-test flag');
    const prebuildIndex = simulatorJob.indexOf('expo prebuild --platform ios');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(prebuildIndex);

    // Parsed, not substring-matched, for the reason the Android copy gives.
    expect(iosWorkflow.on.workflow_dispatch.inputs.crash_test.type).toBe('boolean');
    expect(iosWorkflow.on.workflow_dispatch.inputs.crash_test.default).toBe(false);
  });

  it('never runs a probe on the weekly schedule', () => {
    // `inputs` are all empty on a cron run. The job-level boolean names the
    // event rather than leaning on an input default, the same trap the job's
    // own `if:` documents.
    expect(withoutComments(readIosJob('simulator'))).toContain(
      "CRASH_TEST: ${{ github.event_name == 'workflow_dispatch' && inputs.crash_test == true }}"
    );
  });

  it('keeps the Sentry export off the plain compile check', () => {
    // The default dispatch and the weekly cron must stay exactly what they
    // were: no secrets read, nothing uploaded to Sentry. Gating on
    // HAS_SENTRY alone would make every simulator build upload symbols.
    const exportStep = requireStep('simulator', 'Export the Sentry build env');
    expect(exportStep.if).toBe("env.CRASH_TEST == 'true' && env.HAS_SENTRY == 'true'");
  });

  it('refuses a crash test without Sentry configured', () => {
    // A 25-minute build whose only purpose is a delivered event, and which
    // would report nowhere, is worth failing in the first second.
    const refusal = requireStep('simulator', 'Refuse a crash test without Sentry configured');
    expect(refusal.if).toBe("env.CRASH_TEST == 'true' && env.HAS_SENTRY != 'true'");
  });

  it('refuses a probe build that is also a TestFlight submission, in both build jobs', () => {
    // iOS has no plan job, so the refusal is the first step of both build
    // jobs: at least one of them runs on any dispatch, whatever `target` says.
    for (const jobName of ['simulator', 'device']) {
      const refusal = requireStep(jobName, 'Refuse a probe build that is also a store submission');
      expect(refusal.if).toContain('inputs.crash_test == true');
      expect(refusal.if).toContain("inputs.submit == 'testflight'");
    }
    // The submit job will not run for a probe build even if the refusal were
    // ever removed, mirroring submit-play on Android.
    expect(iosWorkflow.jobs['submit-testflight'].if).toContain('inputs.crash_test != true');
    // The refusal compares against the literal 'testflight'; a changed default
    // would turn it into a refusal of every ordinary dispatch.
    expect(iosWorkflow.on.workflow_dispatch.inputs.submit.default).toBe('none');
  });

  it('refuses a probe build combined with the screenshot capture', () => {
    // A screenshot run skips the `smoke` step, which is the only writer of
    // `steps.smoke.outputs.device-id`, so the probe flows would run against
    // `maestro --device ""` and fail after a 25-minute build.
    const refusal = requireStep('simulator', 'Refuse a probe build combined with the screenshot capture');
    expect(refusal.if).toContain('inputs.crash_test == true');
    expect(refusal.if).toContain("inputs.screenshots == 'true'");
  });

  it('ad-hoc signs the probe builds', () => {
    // An unsigned Release app boots with errSecMissingEntitlement rejections
    // from expo-secure-store and expo-notifications, which the SDK's
    // unhandled-rejection tracking would report into the very run meant to
    // produce two clean events. `withoutComments` because the comment above
    // the line names SIGN_AD_HOC too.
    expect(withoutComments(readIosJob('simulator'))).toContain(
      "SIGN_AD_HOC: ${{ (inputs.screenshots == 'true' || inputs.crash_test == true || inputs.nse_probe == true) && '1' || '' }}"
    );
  });

  it('asserts a dSYM was produced for a crash-test build', () => {
    // The Sentry debug-files phase uploads whatever dSYM the build emitted.
    // With none, the native crash arrives as bare addresses and the run
    // still reads green.
    const verifyStep = requireStep('simulator', 'Verify an app bundle was produced');
    expect(verifyStep.run).toContain('.app.dSYM');
  });

  it('keeps the simulator booted and installs Maestro for a probe run', () => {
    const smokeStep = requireStep('simulator', 'Launch the app on a simulator');
    expect(smokeStep.env?.KEEP_SIMULATOR_BOOTED).toContain('inputs.crash_test == true');
    const installStep = requireStep('simulator', 'Install Maestro and its iOS driver');
    expect(installStep.if).toContain('inputs.crash_test == true');
  });

  it('drives the crash-test flows against the simulator the smoke step booted', () => {
    const flowsStep = requireStep('simulator', 'Run the crash-test flows');
    expect(flowsStep.if).toContain("env.CRASH_TEST == 'true'");
    expect(flowsStep.env?.MAESTRO_DEVICE).toBe('${{ steps.smoke.outputs.device-id }}');
    // A renamed flow otherwise fails deep into a run, after the build.
    for (const flowPath of ['.maestro/probes/crash-test-js.yaml', '.maestro/probes/crash-test-native.yaml']) {
      expect(flowsStep.run).toContain(flowPath);
      expect(existsSync(`${repositoryRoot}${flowPath}`), `${flowPath} is missing`).toBe(true);
    }
  });

  it('relaunches the app after each crash so the stored envelopes are sent', () => {
    // sentry-cocoa stores a fatal event's envelope to disk and sends it on the
    // NEXT launch (RNSentry.mm's storeEnvelope for hardCrashed), and that is
    // true of the JS throw as much as the native crash. A flow that taps and
    // never relaunches proves the crash happened and delivers nothing.
    const flowsStep = requireStep('simulator', 'Run the crash-test flows');
    const sequence = (flowsStep.run ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('run_flow ') || line === 'relaunch_and_flush')
      .map((line) => (line.startsWith('run_flow ') ? 'run_flow' : 'relaunch_and_flush'));
    expect(sequence).toEqual(['run_flow', 'relaunch_and_flush', 'run_flow', 'relaunch_and_flush']);
  });

  it('uploads the probe evidence even when a flow fails', () => {
    // The crash reports, the unified log and the Maestro debug output are
    // what turns a silent non-delivery into a diagnosable one, so they must
    // survive a red step. Maestro writes under a dot directory, hence the
    // hidden-files flag (the screenshot artifact learned the same lesson).
    const collectStep = requireStep('simulator', 'Collect the crash evidence');
    expect(collectStep.if).toContain('always()');
    const uploadStep = requireStep('simulator', 'Upload the probe evidence');
    expect(uploadStep.if).toContain('always()');
    expect(uploadStep.with?.['include-hidden-files']).toBe(true);
  });

  /**
   * The NSE probe: `build-ios.yml -f nse_probe=true` seeds known push vectors
   * into the shared Keychain from Settings, seals a push with the same vectors
   * on the runner, `simctl push`es it to the simulator, and reads back what the
   * OS actually displayed. It exists because a delivered notification cannot
   * distinguish "the extension decrypted" from "the extension never ran": the
   * placeholder renders on any failure by design.
   */
  describe('NSE probe', () => {
    it('defaults the nse_probe input off and names the dispatch event in its job env', () => {
      expect(iosWorkflow.on.workflow_dispatch.inputs.nse_probe.type).toBe('boolean');
      expect(iosWorkflow.on.workflow_dispatch.inputs.nse_probe.default).toBe(false);
      expect(withoutComments(readIosJob('simulator'))).toContain(
        "NSE_PROBE: ${{ github.event_name == 'workflow_dispatch' && inputs.nse_probe == true }}"
      );
    });

    it('exports the probe flag and the UN-prefixed shared Keychain group before prebuild', () => {
      // Both are EXPO_PUBLIC_* values inlined at bundle time. The group is the
      // un-prefixed literal on purpose: an ad-hoc simulator build has no team,
      // so $(AppIdentifierPrefix) in the entitlements expands to nothing, and a
      // team-prefixed literal (which would also be personal information in a
      // public workflow) would send the app's writes somewhere the extension
      // cannot read.
      const simulatorJob = readIosJob('simulator');
      const exportIndex = simulatorJob.indexOf('Export the NSE probe env');
      const prebuildIndex = simulatorJob.indexOf('expo prebuild --platform ios');
      expect(exportIndex).toBeGreaterThan(-1);
      expect(exportIndex).toBeLessThan(prebuildIndex);
      const exportStep = requireStep('simulator', 'Export the NSE probe env');
      expect(exportStep.if).toBe("env.NSE_PROBE == 'true'");
      expect(exportStep.run).toContain('EXPO_PUBLIC_KANGENTIC_NSE_PROBE=1');
      expect(exportStep.run).toContain('EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP=com.kangentic.mobile.shared');
      expect(simulatorJob).not.toMatch(/[A-Z0-9]{10}\.com\.kangentic/);
    });

    it('refuses a probe build that is also a TestFlight submission or a screenshot capture', () => {
      for (const jobName of ['simulator', 'device']) {
        expect(requireStep(jobName, 'Refuse a probe build that is also a store submission').if).toContain(
          'inputs.nse_probe == true'
        );
      }
      expect(requireStep('simulator', 'Refuse a probe build combined with the screenshot capture').if).toContain(
        'inputs.nse_probe == true'
      );
      expect(iosWorkflow.jobs['submit-testflight'].if).toContain('inputs.nse_probe != true');
    });

    it('ad-hoc signs, keeps the simulator booted and installs Maestro for the probe', () => {
      expect(requireStep('simulator', 'Launch the app on a simulator').env?.KEEP_SIMULATOR_BOOTED).toContain(
        'inputs.nse_probe == true'
      );
      expect(requireStep('simulator', 'Install Maestro and its iOS driver').if).toContain('inputs.nse_probe == true');
    });

    it('verifies the entitlement group the built bundles actually carry, before anything is seeded', () => {
      // Whether the simulator honours a shared access group between two
      // ad-hoc-signed bundles is the probe's most uncertain assumption, so the
      // observed entitlement is printed and asserted BEFORE the simulator time
      // is spent, and a wrong literal fails naming the value to correct.
      const simulatorJob = readIosJob('simulator');
      const verifyStep = requireStep('simulator', 'Verify the shared Keychain group the simulator bundles carry');
      expect(verifyStep.if).toBe("env.NSE_PROBE == 'true'");
      expect(verifyStep.run).toContain('codesign');
      expect(verifyStep.run).toContain('PlugIns/KangenticNSE.appex');
      expect(simulatorJob.indexOf('Verify the shared Keychain group')).toBeLessThan(simulatorJob.indexOf('Run the NSE probe'));
    });

    it('drives the probe with the seal script and simctl push, against the simulator the smoke step booted', () => {
      const probeStep = requireStep('simulator', 'Run the NSE probe');
      expect(probeStep.if).toContain("env.NSE_PROBE == 'true'");
      expect(probeStep.env?.MAESTRO_DEVICE).toBe('${{ steps.smoke.outputs.device-id }}');
      expect(probeStep.run).toContain('scripts/sealNseProbePush.mjs');
      expect(probeStep.run).toContain('simctl push');
      // The app is killed before the push: a notification for a terminated app
      // is rendered by SpringBoard with no foreground-presentation question.
      expect(probeStep.run).toContain('simctl terminate');
      for (const flowPath of ['.maestro/probes/nse-seed.yaml', '.maestro/probes/nse-read.yaml']) {
        expect(probeStep.run).toContain(flowPath);
        expect(existsSync(`${repositoryRoot}${flowPath}`), `${flowPath} is missing`).toBe(true);
      }
    });

    it('uploads the probe evidence even when the probe fails', () => {
      const uploadStep = requireStep('simulator', 'Upload the probe evidence');
      expect(uploadStep.if).toContain("env.NSE_PROBE == 'true'");
      expect(String(uploadStep.with?.path)).toContain('nse-probe');
    });
  });
});

describe('build-ios simulator compile cost', () => {
  it('builds one simulator architecture, not both', () => {
    // `generic/platform=iOS Simulator` resolves ARCHS to `arm64 x86_64`, and
    // macos-latest is arm64, so the x86_64 half is compiled and discarded.
    // MEASURED on run 30464295817: 4664 Objects-normal/x86_64 outputs against
    // 5335 arm64, all under Pods.build, in a 21m 07s step. The app target
    // already excluded x86_64; the pod targets did not, and only a
    // command-line build setting reaches them.
    // Comments stripped: the block above this flag explains it at length and
    // names it, so a whole-slice match stays green with the flag deleted.
    expect(withoutComments(readIosJob('simulator'))).toContain('EXCLUDED_ARCHS=x86_64');
  });

  it('keeps the generic destination rather than naming a device', () => {
    // A concrete `-destination ...,name=iPhone 16` would couple this job to a
    // device name the runner image is free to rename or drop.
    expect(withoutComments(readIosJob('simulator'))).toContain(
      "-destination 'generic/platform=iOS Simulator'"
    );
  });

  it('leaves the device archive alone, which is already single-architecture', () => {
    // `generic/platform=iOS` is arm64 by definition. Excluding x86_64 there
    // would be noise, and an EXCLUDED_ARCHS that empties the list produces no
    // binary at all.
    expect(withoutComments(readIosJob('device'))).not.toContain('EXCLUDED_ARCHS');
  });

  it('does not cache CocoaPods in the simulator job', () => {
    // Measured at a 60s ceiling for the WHOLE pod install step, against an
    // ios/Pods cache entry of hundreds of MB competing for a 10 GB
    // per-repository budget that Build (APK) - which IS on the merge path -
    // depends on. The device job's own Pods cache had already been evicted when
    // this was measured, so it was costing budget and returning nothing.
    expect(withoutComments(readIosJob('simulator'))).not.toContain('actions/cache');
  });
});

describe('ci.yml Native config (prebuild) R8 checks', () => {
  function readCiJobs(): Record<string, { steps?: { name?: string; run?: string }[] }> {
    const ciSource = readFileSync(`${repositoryRoot}.github/workflows/ci.yml`, 'utf8');
    const ci = parseYaml(ciSource) as {
      jobs: Record<string, { steps?: { name?: string; run?: string }[] }>;
    };
    return ci.jobs;
  }

  it('confirms R8 against the generated gradle.properties, not build.gradle', () => {
    // expo-build-properties writes these as GRADLE PROPERTIES, and the
    // generated release block reads them through findProperty, so
    // `minifyEnabled true` never appears literally in build.gradle. Asserting
    // against build.gradle here would pass against a config that silently
    // dropped both flags.
    const step = readCiJobs()['native-config'].steps?.find(
      (candidate) => candidate.name === 'Confirm R8 is enabled for release builds'
    );
    expect(step?.run).toContain('android.enableMinifyInReleaseBuilds');
    expect(step?.run).toContain('android.enableShrinkResourcesInReleaseBuilds');
    expect(step?.run).toContain('android/gradle.properties');
    expect(step?.run).not.toContain('build.gradle');
  });

  it('confirms the Sentry Android Gradle Plugin in its enabled form, not just by name', () => {
    // The plugin always writes the `autoUploadProguardMapping` line, with
    // `false` as the value when the upload is off, so matching the bare
    // property name alone would pass just as happily with uploads disabled.
    const step = readCiJobs()['native-config'].steps?.find(
      (candidate) => candidate.name === 'Confirm the Sentry plugin actually wired itself in'
    );
    expect(step?.run).toContain('io.sentry.android.gradle');
    expect(step?.run).toContain('autoUploadProguardMapping = shouldSentryAutoUpload()');
  });

  it('confirms android/sentry.properties actually exists, not merely mentioned', () => {
    // withSentryAndroid writes this file inside a try/catch that only
    // warnOnce()s on failure, so a broken writer leaves prebuild green with no
    // properties file on disk. The org/project-slug test below also contains
    // the bare string "android/sentry.properties" (it names the file in the
    // for-loop's iteration list), so that substring alone would pass even if
    // this existence guard were deleted outright. Match the actual `[ ! -f ... ]`
    // guard text, which only this check emits.
    const step = readCiJobs()['native-config'].steps?.find(
      (candidate) => candidate.name === 'Confirm the Sentry plugin actually wired itself in'
    );
    expect(step?.run).toContain('[ ! -f android/sentry.properties ]');
  });

  it('pins the Sentry org and project slug in BOTH generated properties files', () => {
    // The slug is what sentry-cli's --org/--project are built from, and a wrong
    // one 404s the upload during a real release rather than failing here. Both
    // files are named deliberately: android/sentry.properties is the one
    // sentry.gradle reads, and it is written inside a try/catch that only
    // warnOnce()s, so its absence would otherwise leave prebuild green.
    //
    // The literal slug is pinned in two places on purpose. This test pins what
    // ci.yml asserts; tests/unit/appConfigBrand.test.ts pins the
    // app.config.ts option the generator reads. A future rename has to update
    // both, which is precisely the partial-rename failure being guarded.
    //
    // Match the ANCHORED grep pattern, quotes included, not the bare slug. Each
    // slug also appears in the neighbouring `::error::` message, so a bare
    // `defaults.project=mobile` match passes against a step whose actual grep
    // has been changed to something else entirely. That vacuous pass is not
    // hypothetical: this test had it until a mutation run caught it.
    const step = readCiJobs()['native-config'].steps?.find(
      (candidate) => candidate.name === 'Confirm the Sentry plugin actually wired itself in'
    );
    expect(step?.run).toContain('android/sentry.properties');
    expect(step?.run).toContain('ios/sentry.properties');
    expect(step?.run).toContain('"^defaults.org=kangentic$"');
    expect(step?.run).toContain('"^defaults.project=mobile$"');
  });
});

describe('workflow env-gated steps are defined in their own job', () => {
  // `env` does not cross a job boundary. A step gated on `env.FOO` in a job that
  // never declares FOO does not error: the condition is simply false and the step
  // SKIPS, while the job still reports success.
  //
  // That is not hypothetical. `submit-testflight` gated its "Wait for Apple to
  // accept the build" step on HAS_ASC_API_KEY, which was declared only on the
  // `device` job. The step skipped on every run, the job went green, and a build
  // Apple had rejected passed for a successful release - the exact failure the step
  // was written to catch.
  //
  // Parsed with the yaml package that is already a transitive dependency, because
  // this needs job structure rather than a text match.
  const workflowFiles = ['build-ios.yml', 'build-android.yml', 'ci.yml', 'e2e.yml', 'cache-cleanup.yml'];

  it.each(workflowFiles)('%s gates steps only on env its job defines', (workflowFile) => {
    const source = readFileSync(`${repositoryRoot}.github/workflows/${workflowFile}`, 'utf8');
    const workflow = parseYaml(source) as {
      env?: Record<string, unknown>;
      jobs: Record<string, { env?: Record<string, unknown>; steps?: { if?: string }[] }>;
    };

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const declared = new Set([
        ...Object.keys(workflow.env ?? {}),
        ...Object.keys(job.env ?? {}),
      ]);

      for (const step of job.steps ?? []) {
        for (const match of (step.if ?? '').matchAll(/env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
          expect(
            declared.has(match[1]),
            `${workflowFile}: job "${jobName}" gates a step on env.${match[1]}, which that job does not define. ` +
              'The step will silently skip and the job will still pass.'
          ).toBe(true);
        }
      }
    }
  });
});

/**
 * `Build (APK)` is roughly 88% of the merge gate, so what that one Gradle
 * invocation does or skips is the single biggest lever on how long a pull
 * request waits. Both things locked here are invisible in a passing run: the
 * exclusion saves time nothing reports, and the asset guard catches a failure
 * that is otherwise completely silent.
 */
describe('e2e APK build cost and the shrink guard', () => {
  const e2eWorkflow = parseYaml(
    readFileSync(`${repositoryRoot}.github/workflows/e2e.yml`, 'utf8')
  ) as { jobs: Record<string, { steps?: { name?: string; run?: string }[] }> };

  const buildApkSteps = e2eWorkflow.jobs['build-apk'].steps ?? [];

  function readGradleStep(): string {
    const gradleStep = buildApkSteps.find((step) => step.name === 'Build the release APK');
    // ASSERTED, not defaulted. This lookup used to feed `gradleStep?.run ?? ''`
    // into a `not.toContain`, so renaming the step turned the guard below into a
    // check against the empty string - green, and no longer guarding anything.
    // Verified by mutating the name: the lintVitalRelease test still passed.
    expect(gradleStep, 'e2e.yml no longer has a "Build the release APK" step').toBeDefined();
    return withoutComments(gradleStep?.run ?? '');
  }

  it('does not exclude lintVitalRelease, which was measured and bought nothing', () => {
    // The premise is TRUE and the exclusion WORKS: `-x lint` does not cover
    // `lintVitalRelease`, and adding it drops 1029 actionable tasks to 672 with
    // all 54 lintVital tasks gone. It just does not make the job faster, because
    // those tasks run in parallel and were never on the critical path.
    //
    // Measured 2026-07-30, normalised against buildCMake + minifyReleaseWithR8
    // (identical work in both arms, since the raw clock on this job is dominated
    // by cache health):
    //
    //   lint ON   n=2  ratios 2.41, 2.13        mean 2.27
    //   lint OFF  n=3  ratios 2.12, 2.60, 2.21  mean 2.31
    //
    // This test exists so the idea is not silently re-landed on the strength of
    // the premise alone, which is exactly how it got landed the first time. The
    // full write-up, including what misled the first pass, is in e2e.yml.
    expect(readGradleStep()).not.toContain('lintVitalRelease');
  });

  it('verifies the terminal page survived shrinking, in both Android workflows', () => {
    // xterm.html is required() from the JS bundle, which the resource shrinker
    // never scans, so nothing anchors it. If it were dropped, the Terminal pane
    // (the DEFAULT session view) would render blank and every check would stay
    // green - no Maestro flow asserts WebView content.
    const verifyStep = buildApkSteps.find((step) => step.run?.includes('verify-android-assets.sh'));
    expect(verifyStep, 'e2e.yml no longer verifies the terminal page survived R8').toBeDefined();
    expect(workflowSource).toContain('verify-android-assets.sh');
  });

  it('matches the terminal page by size, never by resource path', () => {
    // optimizeReleaseResources RENAMES the entry: on run 30506459459 the shipped
    // artifact carried it as `res/JU.html`, not `res/raw/xterm.html`. A path
    // check would therefore go red on a correct build, which is worse than no
    // check at all.
    // CODE ONLY, via the shared helper. The script explains this exact reasoning
    // in its header, so a whole-file match reads the justification as the
    // violation. (That is not a guess about how it could go wrong: it is how
    // this assertion first failed.)
    const guardCode = withoutComments(
      readFileSync(`${repositoryRoot}.github/scripts/verify-android-assets.sh`, 'utf8')
    );

    // Candidate entries are selected by EXTENSION, so an obfuscated name still
    // matches...
    expect(guardCode).toContain('$NF ~ /\\.html$/');
    // ...and the decision is a size comparison against the source file, which is
    // what makes the rename irrelevant. Reading the size rather than hardcoding
    // it is also what keeps this tracking scripts/buildXtermHtml.mjs.
    expect(guardCode).toContain('src/terminal/xterm.html');
    expect(guardCode).toContain('wc -c');
    expect(guardCode).toContain('"$entry_bytes" = "$expected_bytes"');
  });

  it('decides the size match without piping into grep', () => {
    // verify-android-signature.sh's header records `printf | grep -q` failing a
    // correctly signed production AAB TWICE: grep -q exits on first match, the
    // writer takes SIGPIPE, and `set -o pipefail` reports 141 on a real match.
    // Reproduced here before the rewrite - the shape returns 141, so a correct
    // artifact would have been failed. The whole point of this guard is that it
    // cannot go red on a good build, so it must not reintroduce that shape.
    const guardCode = withoutComments(
      readFileSync(`${repositoryRoot}.github/scripts/verify-android-assets.sh`, 'utf8')
    );
    expect(guardCode).not.toMatch(/\|\s*grep\s+-[a-zA-Z]*q/);
  });
});

/**
 * The Actions cache is 10 GB PER REPOSITORY, evicted by last access across every
 * ref. Nothing about exceeding it fails a build: caches simply stop hitting, and
 * the job gets slower with every check still green. That is not hypothetical.
 * MEASURED 2026-07-30 at 9.86 GB of the cap, with `Build (APK)` on run
 * 30506459459 reporting `147 from cache` of 1029 tasks against `415 of 1055` on
 * three healthy runs, and taking 14m 53s against roughly 8m. It was read as an
 * R8 regression before it was measured.
 *
 * So the two things holding that budget down are load bearing and invisible, and
 * each test below names the specific regression it exists to catch.
 */
describe('Actions cache budget', () => {
  // PARSED, not text-matched. Both of the first two tests below assert the
  // ABSENCE of a setting, and the file explains in prose why each is absent, so
  // a substring check reads its own justification as the violation. That is not
  // a hypothetical either: it is how these two first failed.
  interface CompositeStep {
    uses?: string;
    with?: Record<string, unknown>;
  }
  const setupNodeDeps = parseYaml(
    readFileSync(`${repositoryRoot}.github/actions/setup-node-deps/action.yml`, 'utf8')
  ) as { runs: { steps: CompositeStep[] } };

  const cacheCleanupSource = readFileSync(
    `${repositoryRoot}.github/workflows/cache-cleanup.yml`,
    'utf8'
  );

  interface CleanupStep {
    name?: string;
    if?: string;
    env?: Record<string, string>;
    run?: string;
  }
  // Parsed ONCE, and the step lookup shared. Four tests below each re-parsed
  // this same file with a slightly different inline type, which is three extra
  // chances for those shapes to drift apart while describing one document.
  const cacheCleanupWorkflow = parseYaml(cacheCleanupSource) as {
    on: Record<string, unknown>;
    permissions?: Record<string, string>;
    concurrency?: { group?: string };
    jobs: Record<string, { steps?: CleanupStep[] }>;
  };
  const cacheCleanupSteps = cacheCleanupWorkflow.jobs.cleanup.steps ?? [];

  function cleanupStepNamed(namePrefix: string): CleanupStep {
    const step = cacheCleanupSteps.find((candidate) => candidate.name?.startsWith(namePrefix));
    expect(step, `cache-cleanup.yml no longer has a "${namePrefix}" step`).toBeDefined();
    return step as CleanupStep;
  }

  function compositeStepUsing(actionPrefix: string): CompositeStep {
    const step = setupNodeDeps.runs.steps.find((candidate) => candidate.uses?.startsWith(actionPrefix));
    expect(step, `setup-node-deps no longer uses ${actionPrefix}`).toBeDefined();
    return step as CompositeStep;
  }

  it('keeps the npm download cache out of the shared setup composite', () => {
    // `cache: npm` keys on the same package-lock.json hash as the node_modules
    // cache beside it, so the two hit and miss together and the npm entry is
    // never read on a hit. Re-adding it looks harmless and costs ~1.9 GB of a
    // 10 GB cap, paid by evicting the Gradle cache Build (APK) depends on.
    expect(compositeStepUsing('actions/setup-node').with?.cache).toBeUndefined();
  });

  it('never restores node_modules through a partial key', () => {
    // A restore-key would hand a job node_modules built from a DIFFERENT
    // lockfile. That is the drift scripts/checkInstallDrift.mjs exists to catch,
    // and it presents as "has no exported member" errors in untouched files.
    expect(compositeStepUsing('actions/cache').with?.['restore-keys']).toBeUndefined();
  });

  it('installs through the composite in every build-android job', () => {
    // Two jobs used a raw setup-node plus an unconditional `npm ci` while the
    // rest of the repository restored node_modules from a shared lockfile-keyed
    // cache. Both forms work, so nothing but this test notices the slow one.
    const androidWorkflow = parseYaml(workflowSource) as {
      jobs: Record<string, { steps?: { uses?: string; run?: string }[] }>;
    };
    const steps = Object.values(androidWorkflow.jobs).flatMap((job) => job.steps ?? []);

    expect(steps.some((step) => step.uses === './.github/actions/setup-node-deps')).toBe(true);
    for (const step of steps) {
      // `expect(step.uses?.startsWith(...)).not.toBe(true)` passes on undefined
      // for the same reason it passes on false, so it read as a check while
      // asserting almost nothing. Coerce first, then match.
      expect(step.uses ?? '').not.toMatch(/^actions\/setup-node/);
      // Matched as a WORD anywhere in the block rather than compared to the
      // whole trimmed string: `npm ci --prefer-offline`, or an `npm ci` on any
      // line of a multi-line run, slipped straight past the equality check.
      // Comments stripped, since a shell comment may legitimately name it.
      expect(withoutComments(step.run ?? '')).not.toMatch(/\bnpm (ci|install)\b/);
    }
  });

  it('scopes each cache-cleanup path to its own event', () => {
    // github.event.pull_request is EMPTY on a workflow_dispatch, so an ungated
    // ref expression expands to `refs/pull//merge`, matches nothing, and reports
    // success having deleted nothing. build-ios.yml:96-99 records the same trap
    // firing a signed device build every Monday.
    // Every step that interpolates a pull-request ref must be gated on the
    // pull_request event, whatever it is called.
    const pullRequestSteps = cacheCleanupSteps.filter((step) =>
      Object.values(step.env ?? {}).some((value) => value.includes('github.event.pull_request'))
    );
    expect(pullRequestSteps.length).toBeGreaterThan(0);
    for (const step of pullRequestSteps) {
      expect(step.if).toBe("github.event_name == 'pull_request'");
    }

    expect(cleanupStepNamed('Sweep caches').if).toContain("github.event_name == 'workflow_dispatch'");
  });

  it('grants the pull-requests scope the sweep depends on', () => {
    // Naming a `permissions:` block sets every UNLISTED scope to `none`. The
    // sweep calls `gh pr list` to build the set of refs it must SPARE, so
    // omitting pull-requests: read does not merely skip the sweep - it returns
    // an empty spare-list and deletes the caches of every open pull request,
    // which is the exact opposite of the step's stated guarantee.
    expect(cacheCleanupWorkflow.permissions?.['pull-requests']).toBe('read');
    expect(cacheCleanupWorkflow.permissions?.actions).toBe('write');
  });

  it('refuses to sweep when the open-pull-request list cannot be read', () => {
    // Belt to the permission's braces. Any failure of that call (rate limit,
    // outage, a future scope change) yields an empty spare-list, which reads as
    // "nothing to protect" rather than as an error, so it must abort instead of
    // falling through into the delete loop.
    const sweepRun = cleanupStepNamed('Sweep caches').run ?? '';
    expect(sweepRun).toMatch(/if\s+!\s+open_refs=/);
    expect(sweepRun).toContain('exit 1');
  });

  it('serialises overlapping runs so a dispatch cannot race the schedule', () => {
    // Every other workflow in the directory declares one; this is the only one
    // that can be triggered two ways at once.
    expect(cacheCleanupWorkflow.concurrency?.group).toContain('cache-cleanup');
  });

  it('sweeps stranded refs weekly, not only on demand', () => {
    // The PR-close path cannot clean a FORK pull request: GitHub downgrades
    // GITHUB_TOKEN to read-only for a pull_request event from a fork whatever
    // `permissions:` says. This repository is public, so that is a recurring
    // leak rather than a corner case, and the sweep is its only backstop.
    // The prune step is NOT that backstop - it is scoped to the default branch.
    expect(cleanupStepNamed('Sweep caches').if).toContain("github.event_name == 'schedule'");
  });

  it('spares the default branch and open pull requests when sweeping', () => {
    // The sweep deletes by ref. Without these two guards it would delete main's
    // Gradle User Home entry, which is the ONLY cache every other ref can read -
    // turning a cleanup into precisely the starvation it exists to prevent.
    const sweep = cleanupStepNamed('Sweep caches');

    expect(sweep.env?.DEFAULT_BRANCH).toContain('default_branch');
    expect(sweep.run).toContain('"$ref" = "$DEFAULT_BRANCH"');
    expect(sweep.run).toContain('--state open');
    // -x -F, so refs/heads/main cannot spare refs/heads/mainline by substring.
    expect(sweep.run).toContain('grep -qxF');
  });

  it('prunes superseded generations on a schedule, not only by hand', () => {
    // The default branch grows WITHOUT any pull request involved: each
    // dependency change writes a new generation of the same cache family and
    // the old one lingers. MEASURED 2026-07-30 at 3 generations of
    // gradle-transforms (4.36 GB) and 2 of gradle-dependencies (1.96 GB), which
    // is 6.3 GB of a 7.32 GB total. Manual-only cleanup would mean nobody runs
    // it until Build (APK) is already slow, which is the state this whole change
    // started from.
    expect(cacheCleanupWorkflow.on.schedule).toBeDefined();

    const prune = cleanupStepNamed('Prune superseded');
    expect(prune.if).toContain("github.event_name == 'schedule'");
    // `inputs` is empty on a schedule, so the count must not depend on it.
    expect(prune.env?.KEEP).toContain("|| '2'");
    // Scoped to the default branch, and keeps the NEWEST by creation date. Both
    // values are BOUND as jq arguments rather than spliced into the program
    // text, so a stray character in either is data, not a syntax error.
    expect(prune.run).toContain('--arg default_branch "$DEFAULT_BRANCH"');
    expect(prune.run).toContain('--argjson keep "$KEEP"');
    expect(prune.run).toContain('select(.ref == $default_branch)');
    expect(prune.run).toContain('sort_by(.createdAt) | reverse');
  });

  it('advertises the same keep default that a scheduled run falls back to', () => {
    // Two copies of `2`: the workflow_dispatch input default, and the `|| '2'`
    // the schedule path needs because `inputs` is empty there. Nothing keeps
    // them equal, so changing the advertised default alone would leave every
    // scheduled run quietly using the old number.
    const dispatch = (cacheCleanupWorkflow.on as {
      workflow_dispatch?: { inputs?: Record<string, { default?: string }> };
    }).workflow_dispatch;
    const advertisedDefault = dispatch?.inputs?.keep?.default;

    expect(advertisedDefault).toBeDefined();
    expect(cleanupStepNamed('Prune superseded').env?.KEEP).toContain(`|| '${advertisedDefault}'`);
  });

  it('reports a prune count even when it deletes nothing', () => {
    // Without it, a run that pruned nothing prints nothing at all, which reads
    // as a step that never ran. This is a legibility guarantee, NOT a validation
    // one: a jq filter that compiles but selects nothing still reports
    // "Pruned 0". Catching that is the usage report's job, not this count's.
    const pruneRun = cleanupStepNamed('Prune superseded').run ?? '';
    expect(pruneRun).toContain('pruned_count=0');
    expect(pruneRun).toMatch(/echo "Pruned \$pruned_count/);
    // Counted in THIS shell. `... | while read` puts the body in a subshell and
    // the increment is discarded, which would report 0 after a real prune.
    expect(pruneRun).toContain('done <<< "$superseded"');
  });
});

describe('build-android staged rollout', () => {
  it('keeps the rollout and full-release uploads as separate steps', () => {
    // `userFraction` is only valid with an inProgress status; Play rejects it
    // alongside `completed`. One step with interpolated values would be a silent
    // misconfiguration, so they are two mutually exclusive steps.
    expect(workflowSource).toContain('status: inProgress');
    expect(workflowSource).toContain('status: completed');
    expect(workflowSource).toContain("if: inputs.rollout != ''");
    expect(workflowSource).toContain("if: inputs.rollout == ''");
  });

  it('defaults to a full release rather than a surprise partial one', () => {
    // An empty default means an unqualified dispatch behaves as it always has.
    // A staged rollout has to be asked for, because an unfinished rollout that
    // nobody completes is its own failure mode.
    expect(workflowSource).toMatch(/rollout:[\s\S]{0,200}default: ''/);
  });

  it('refuses an unstaged release to a track with real users', () => {
    // A `completed` Play release can never be pulled back, only superseded by a
    // higher version code, so releasing to alpha or beta without a staged
    // rollout is irreversible the moment it lands. That used to be a prose rule
    // in .claude/skills/release/SKILL.md telling the operator to pass
    // `-f rollout=0.1`, which is the kind of rule that holds right up until
    // somebody is in a hurry.
    //
    // `internal` is deliberately NOT covered: the track is small and known, and
    // the documented recovery there is simply shipping a higher version code.
    const workflow = parseYaml(workflowSource) as {
      jobs: Record<string, { steps?: { name?: string; if?: string }[] }>;
    };
    const refusal = workflow.jobs.plan.steps?.find(
      (step) => step.name === 'Refuse an unstaged release to a track with real users'
    );
    expect(refusal?.if).toBe(
      "(inputs.submit_track == 'alpha' || inputs.submit_track == 'beta') && inputs.rollout == ''"
    );
  });
});

describe('spent release counters are recorded mechanically', () => {
  // Before this, the only record of which counters were spent was a hand-edited
  // comment in app.config.ts. That comment is true when written and rots in
  // silence: a stale "builds 1 and 2 are spent, hence 3" sent the 2026-07-28
  // iOS release at a build number Apple had already taken. A tag cannot drift.
  it('tags the spent version code after the Play upload, and never fails the release for it', () => {
    const workflow = parseYaml(workflowSource) as {
      jobs: Record<
        string,
        {
          permissions?: Record<string, string>;
          steps?: { name?: string; 'continue-on-error'?: boolean }[];
        }
      >;
    };
    const steps = workflow.jobs['submit-play'].steps ?? [];
    const uploadIndex = steps.findIndex(
      (step) => step.name === 'Upload to Google Play (full release)'
    );
    const tagIndex = steps.findIndex(
      (step) => step.name === 'Record the spent version code as a tag'
    );
    expect(uploadIndex).toBeGreaterThanOrEqual(0);
    expect(tagIndex).toBeGreaterThan(uploadIndex);

    // The upload cannot be undone, so a bookkeeping failure must not redden a
    // release that already reached Play.
    expect(steps[tagIndex]?.['continue-on-error']).toBe(true);

    // Creating a ref needs more than the workflow's top-level `contents: read`.
    expect(workflow.jobs['submit-play'].permissions?.contents).toBe('write');
  });

  it('tags the spent build number only after Apple accepts, not merely after upload', () => {
    const workflow = parseYaml(iosWorkflowSource) as {
      jobs: Record<
        string,
        {
          permissions?: Record<string, string>;
          steps?: { name?: string; 'continue-on-error'?: boolean }[];
        }
      >;
    };
    const steps = workflow.jobs['submit-testflight'].steps ?? [];
    const acceptIndex = steps.findIndex((step) => step.name === 'Wait for Apple to accept the build');
    const tagIndex = steps.findIndex(
      (step) => step.name === 'Record the spent build number as a tag'
    );
    expect(acceptIndex).toBeGreaterThanOrEqual(0);

    // Ordering is the whole point. Builds 1 and 2 both reported UPLOAD
    // SUCCEEDED and were then refused by Apple, so a tag written at upload time
    // would record a build that never reached a tester.
    expect(tagIndex).toBeGreaterThan(acceptIndex);
    expect(steps[tagIndex]?.['continue-on-error']).toBe(true);
    expect(workflow.jobs['submit-testflight'].permissions?.contents).toBe('write');
  });

  it('preflights a changed counter on every pull request', () => {
    const ciSource = readFileSync(`${repositoryRoot}.github/workflows/ci.yml`, 'utf8');
    const ci = parseYaml(ciSource) as {
      jobs: Record<string, { if?: string; steps?: { name?: string; run?: string }[] }>;
    };
    const job = ci.jobs['release-counters'];
    expect(job).toBeDefined();
    expect(job.if).toBe("github.event_name == 'pull_request'");

    const runs = (job.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(runs).toContain('scripts/checkPlayVersionCode.mjs');
    expect(runs).toContain('scripts/checkAppStoreBuild.mjs');
  });
});

describe('easProfile.mjs profile resolution', () => {
  it('lists every eas.json build profile', () => {
    expect(runEasProfileScript(['--list']).split('\n')).toEqual(Object.keys(easConfig.build));
  });

  it('resolves the extends chain and merges env', () => {
    const resolved = JSON.parse(runEasProfileScript(['e2e', '--json']));
    expect(resolved.env.EXPO_PUBLIC_KANGENTIC_E2E).toBe('1');
    // Inherited from the preview profile it extends.
    expect(resolved.distribution).toBe('internal');
    // Overridden on the child.
    expect(resolved.channel).toBe('e2e');
    // The directive itself is not part of the resolved profile.
    expect(resolved.extends).toBeUndefined();
  });

  it('reads a dotted field, which is how the workflow picks the Gradle task', () => {
    expect(runEasProfileScript(['e2e', '--field', 'android.buildType'])).toBe('apk');
    expect(runEasProfileScript(['development', '--field', 'android.buildType'])).toBe('apk');
  });

  it('fails loudly on an unknown profile', () => {
    expect(() => runEasProfileScript(['does-not-exist', '--json'])).toThrow();
  });

  it('writes the profile env in GITHUB_ENV format', () => {
    // The workflow relies on this exact shape to get EXPO_PUBLIC_* values into
    // the Gradle step, where Metro inlines them into the bundle. A silent
    // change here would produce an e2e APK without its flag set.
    const githubEnvPath = join(mkdtempSync(join(tmpdir(), 'kangentic-github-env-')), 'github-env');
    writeFileSync(githubEnvPath, '');

    execFileSync(process.execPath, [easProfileScript, 'e2e', '--github-env'], {
      cwd: repositoryRoot,
      env: { ...process.env, GITHUB_ENV: githubEnvPath },
      encoding: 'utf8',
    });
    expect(readFileSync(githubEnvPath, 'utf8')).toBe('EXPO_PUBLIC_KANGENTIC_E2E=1\n');

    // A profile with no env block must contribute nothing rather than a blank line.
    writeFileSync(githubEnvPath, '');
    execFileSync(process.execPath, [easProfileScript, 'preview', '--github-env'], {
      cwd: repositoryRoot,
      env: { ...process.env, GITHUB_ENV: githubEnvPath },
      encoding: 'utf8',
    });
    expect(readFileSync(githubEnvPath, 'utf8')).toBe('');
  });
});
