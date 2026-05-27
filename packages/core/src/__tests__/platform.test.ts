import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetShellCache,
  findPidByPort,
  getDefaultRuntime,
  getEnvDefaults,
  getNodePtyPrebuildsSubdir,
  getShell,
  isMac,
  isLinux,
  isWindows,
  killProcessTree,
} from "../platform.js";

describe("platform", () => {
  afterEach(() => {
    _resetShellCache();
    vi.restoreAllMocks();
  });

  describe("isWindows / isMac / isLinux", () => {
    it("isMac returns true on darwin", () => {
      const orig = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", writable: true, configurable: true });
      expect(isMac()).toBe(true);
      Object.defineProperty(process, "platform", { value: orig, writable: true, configurable: true });
    });

    it("isLinux returns true on linux", () => {
      const orig = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
      expect(isLinux()).toBe(true);
      Object.defineProperty(process, "platform", { value: orig, writable: true, configurable: true });
    });

    it("isWindows returns false on darwin", () => {
      const orig = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", writable: true, configurable: true });
      expect(isWindows()).toBe(false);
      Object.defineProperty(process, "platform", { value: orig, writable: true, configurable: true });
    });
  });

  describe("getDefaultRuntime", () => {
    it("returns tmux on non-Windows", () => {
      const orig = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", writable: true, configurable: true });
      expect(getDefaultRuntime()).toBe("tmux");
      Object.defineProperty(process, "platform", { value: orig, writable: true, configurable: true });
    });

    it("returns process on Windows", () => {
      const orig = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", writable: true, configurable: true });
      expect(getDefaultRuntime()).toBe("process");
      Object.defineProperty(process, "platform", { value: orig, writable: true, configurable: true });
    });
  });

  describe("getNodePtyPrebuildsSubdir", () => {
    it("centralizes node-pty prebuild platform/arch naming", () => {
      const orig = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", writable: true, configurable: true });
      expect(getNodePtyPrebuildsSubdir()).toBe(`darwin-${process.arch}`);
      Object.defineProperty(process, "platform", { value: orig, writable: true, configurable: true });
    });
  });

  describe("getShell", () => {
    it("returns /bin/sh on Unix", () => {
      const orig = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
      _resetShellCache();
      const shell = getShell();
      expect(shell.cmd).toBe("/bin/sh");
      expect(shell.args("echo hi")).toEqual(["-c", "echo hi"]);
      Object.defineProperty(process, "platform", { value: orig, writable: true, configurable: true });
    });

    it("caches the result on subsequent calls", () => {
      const orig = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
      _resetShellCache();
      const s1 = getShell();
      const s2 = getShell();
      expect(s1).toBe(s2);
      Object.defineProperty(process, "platform", { value: orig, writable: true, configurable: true });
    });

    it("uses AO_SHELL override on Windows", () => {
      const origPlatform = process.platform;
      const origAoShell = process.env["AO_SHELL"];
      Object.defineProperty(process, "platform", { value: "win32", writable: true, configurable: true });
      process.env["AO_SHELL"] = "C:\\custom\\shell.exe";
      _resetShellCache();
      const shell = getShell();
      expect(shell.cmd).toBe("C:\\custom\\shell.exe");
      Object.defineProperty(process, "platform", { value: origPlatform, writable: true, configurable: true });
      if (origAoShell === undefined) {
        delete process.env["AO_SHELL"];
      } else {
        process.env["AO_SHELL"] = origAoShell;
      }
    });

    it("falls back to cmd.exe when no PowerShell found on Windows", () => {
      const origPlatform = process.platform;
      const origAoShell = process.env["AO_SHELL"];
      const origComSpec = process.env["ComSpec"];
      const origPath = process.env["PATH"];
      Object.defineProperty(process, "platform", { value: "win32", writable: true, configurable: true });
      delete process.env["AO_SHELL"];
      process.env["ComSpec"] = "cmd.exe";
      process.env["PATH"] = "";
      const origSystemRoot = process.env["SystemRoot"];
      process.env["SystemRoot"] = "/nonexistent";
      _resetShellCache();
      const shell = getShell();
      expect(shell.cmd).toBe("cmd.exe");
      expect(shell.args("dir")).toEqual(["/c", "dir"]);
      Object.defineProperty(process, "platform", { value: origPlatform, writable: true, configurable: true });
      if (origAoShell !== undefined) process.env["AO_SHELL"] = origAoShell; else delete process.env["AO_SHELL"];
      if (origComSpec !== undefined) process.env["ComSpec"] = origComSpec; else delete process.env["ComSpec"];
      if (origPath !== undefined) process.env["PATH"] = origPath; else delete process.env["PATH"];
      if (origSystemRoot !== undefined) process.env["SystemRoot"] = origSystemRoot; else delete process.env["SystemRoot"];
    });
  });

  describe("killProcessTree", () => {
    it("no-ops for pid <= 0", async () => {
      await expect(killProcessTree(0)).resolves.toBeUndefined();
      await expect(killProcessTree(-1)).resolves.toBeUndefined();
    });

    it("kills process group on Unix", async () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      await killProcessTree(12345, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
      Object.defineProperty(process, "platform", { value: origPlatform, writable: true, configurable: true });
    });

    it("falls back to direct kill when process group fails", async () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
      const killSpy = vi.spyOn(process, "kill")
        .mockImplementationOnce(() => { throw new Error("ESRCH"); })
        .mockImplementation(() => true);
      await killProcessTree(99999, "SIGKILL");
      expect(killSpy).toHaveBeenCalledWith(99999, "SIGKILL");
      Object.defineProperty(process, "platform", { value: origPlatform, writable: true, configurable: true });
    });

    it("silently handles already-dead process on Unix", async () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
      vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("ESRCH"); });
      await expect(killProcessTree(77777)).resolves.toBeUndefined();
      Object.defineProperty(process, "platform", { value: origPlatform, writable: true, configurable: true });
    });
  });

  describe("findPidByPort", () => {
    it("returns null on lsof error", async () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
      vi.mock("node:child_process", () => ({
        execFile: vi.fn((_cmd, _args, _opts, cb) => cb(new Error("not found"))),
      }));
      const result = await findPidByPort(9999);
      expect(result).toBeNull();
      Object.defineProperty(process, "platform", { value: origPlatform, writable: true, configurable: true });
      vi.resetModules();
    });
  });

  describe("getEnvDefaults", () => {
    it("returns Unix defaults on Linux", () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
      const defaults = getEnvDefaults();
      expect(defaults).toHaveProperty("HOME");
      expect(defaults).toHaveProperty("SHELL");
      expect(defaults).toHaveProperty("TMPDIR");
      expect(defaults).toHaveProperty("PATH");
      expect(defaults).toHaveProperty("USER");
      Object.defineProperty(process, "platform", { value: origPlatform, writable: true, configurable: true });
    });

    it("returns Windows defaults on win32", () => {
      const origPlatform = process.platform;
      const origUserProfile = process.env["USERPROFILE"];
      Object.defineProperty(process, "platform", { value: "win32", writable: true, configurable: true });
      process.env["USERPROFILE"] = "C:\\Users\\test";
      _resetShellCache();
      const defaults = getEnvDefaults();
      expect(defaults.HOME).toBe("C:\\Users\\test");
      expect(defaults).toHaveProperty("SHELL");
      Object.defineProperty(process, "platform", { value: origPlatform, writable: true, configurable: true });
      if (origUserProfile !== undefined) process.env["USERPROFILE"] = origUserProfile; else delete process.env["USERPROFILE"];
    });
  });
});
