import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// A dedicated single-page browser never restores an unfinished tab after a
// container restart. Clear only Chromium's crash marker while it is stopped;
// cookies, sessions, extensions, and every other preference remain intact.
const preferencesPath = join(process.argv[2], "Default", "Preferences");
if (existsSync(preferencesPath)) {
  const preferences = JSON.parse(readFileSync(preferencesPath, "utf8"));
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
    throw new Error("Chromium Preferences is not an object");
  }
  if (
    !preferences.profile ||
    typeof preferences.profile !== "object" ||
    Array.isArray(preferences.profile)
  ) {
    throw new Error("Chromium profile preferences are unavailable");
  }
  if (preferences.profile.exit_type !== "Normal" || preferences.profile.exited_cleanly !== true) {
    preferences.profile.exit_type = "Normal";
    preferences.profile.exited_cleanly = true;
    const sourceFd = openSync(preferencesPath, "r");
    const sourceMode = fstatSync(sourceFd).mode & 0o777;
    closeSync(sourceFd);
    const temporaryPath = `${preferencesPath}.${process.pid}.tmp`;
    let temporaryFd;
    try {
      temporaryFd = openSync(temporaryPath, "wx", sourceMode);
      writeFileSync(temporaryFd, JSON.stringify(preferences));
      fchmodSync(temporaryFd, sourceMode);
      fsyncSync(temporaryFd);
      closeSync(temporaryFd);
      temporaryFd = undefined;
      renameSync(temporaryPath, preferencesPath);
    } catch (error) {
      if (temporaryFd !== undefined) closeSync(temporaryFd);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      throw error;
    }
  }
}
