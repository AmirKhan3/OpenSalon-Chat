/**
 * Reads settings from a ".env" file in the working directory, if there is one.
 * A variable that is already set (by the shell, Docker, or the host) wins.
 */

/** Load one env file. Returns false when the file does not exist. */
export function loadEnv(path = ".env"): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** True when the server itself was started (not a test that imports it). */
export function isServerEntry(entry: string | undefined): boolean {
  return /(^|[\\/])server\.(ts|js)$/.test(entry ?? "");
}

// Runs on import, so the settings are there before other modules read them.
if (isServerEntry(process.argv[1])) {
  try {
    loadEnv();
  } catch (err) {
    console.error("Tolly could not read the .env file:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
