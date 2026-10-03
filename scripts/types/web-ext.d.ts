/** Minimal typing for the web-ext Node API surface the Firefox harness uses. */
declare module 'web-ext' {
  interface WebExtRunParams {
    sourceDir: string;
    firefox?: string;
    artifactsDir?: string;
    startUrl?: string[];
    noReload?: boolean;
    args?: string[];
    pref?: Record<string, string | number | boolean>;
    profileCreateIfMissing?: boolean;
    firefoxProfile?: string;
    verbose?: boolean;
  }

  interface WebExtRunOptions {
    shouldExitProgram?: boolean;
    logLevel?: string;
  }

  interface WebExtRunner {
    extensionRunners?: Array<{
      runningInfo?: { firefox?: { kill(signal?: string): void }; debuggerPort?: number };
      quit?(): Promise<void>;
    }>;
  }

  const webExt: {
    cmd: {
      run(params: WebExtRunParams, options?: WebExtRunOptions): Promise<WebExtRunner>;
    };
  };

  export default webExt;
}
