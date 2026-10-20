// Build-time settings (Docker build args in CI). Unset in dev, tests and forks: Sentry and analytics stay off.
interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_AMPLITUDE_API_KEY?: string;
  /** The commit the bundle was built from; the landing page shows it as its build. */
  readonly VITE_RELEASE?: string;
}
