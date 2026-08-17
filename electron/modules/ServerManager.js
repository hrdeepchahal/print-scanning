"use strict";

const { fork } = require("child_process");
const { EventEmitter } = require("events");
const path = require("path");

// 1s, 2s, 4s, 8s, 16s, then cap at 60s.
const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 16000, 60000];
const STABLE_AFTER_MS = 60000;

/**
 * Owns the Express service as a forked child process: startup, IPC-based
 * readiness detection, log forwarding, and crash restart with exponential
 * backoff. Emits 'online' / 'offline' / 'log' — knows nothing about the tray
 * or any UI.
 */
class ServerManager extends EventEmitter {
  constructor({ serverEntry, env = {} }) {
    super();
    this.serverEntry = serverEntry;
    this.env = env;
    this.child = null;
    this.online = false;
    this.restartAttempt = 0;
    this.stableTimer = null;
    this.isQuitting = false;
  }

  getStatus() {
    return {
      online: this.online,
      pid: this.child ? this.child.pid : null,
      restartAttempt: this.restartAttempt,
    };
  }

  start() {
    if (this.child) return;

    this.emit("log", `Starting server (attempt ${this.restartAttempt + 1})`, "info");

    this.child = fork(this.serverEntry, [], {
      cwd: path.dirname(this.serverEntry),
      silent: true, // no inherited stdout/stderr — packaged apps have no terminal to inherit
      env: { ...process.env, ...this.env, ELECTRON_FORKED: "1" },
    });

    this.child.stdout.on("data", (d) => this._forwardLog("info", d));
    this.child.stderr.on("data", (d) => this._forwardLog("error", d));

    this.child.on("message", (msg) => {
      if (msg && msg.type === "server:ready") {
        this.online = true;
        this.emit("online", msg.payload);
        this.stableTimer = setTimeout(() => {
          this.restartAttempt = 0; // ran stably — forget prior crash history
        }, STABLE_AFTER_MS);
      }
    });

    this.child.on("error", (err) => {
      this.emit("log", `Server process error: ${err.message}`, "error");
    });

    this.child.on("exit", (code, signal) => {
      this.emit("log", `Server exited (code=${code}, signal=${signal})`, "warn");
      this.child = null;
      this.online = false;
      if (this.stableTimer) {
        clearTimeout(this.stableTimer);
        this.stableTimer = null;
      }
      this.emit("offline");
      if (!this.isQuitting) this._scheduleRestart();
    });
  }

  _scheduleRestart() {
    const delay = BACKOFF_STEPS_MS[Math.min(this.restartAttempt, BACKOFF_STEPS_MS.length - 1)];
    this.restartAttempt++;
    this.emit("log", `Restarting server in ${delay}ms (attempt ${this.restartAttempt})`, "warn");
    setTimeout(() => this.start(), delay);
  }

  _forwardLog(level, data) {
    data
      .toString()
      .split("\n")
      .filter(Boolean)
      .forEach((line) => this.emit("log", line, level));
  }

  /** Ask the server to shut down over IPC; force-kill if it hasn't exited within 3s. */
  stop() {
    if (!this.child) return;
    const child = this.child;
    try {
      child.send({ type: "shutdown" });
    } catch (_) {}
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGTERM");
        } catch (_) {}
      }
    }, 3000);
  }

  /** Manual restart (tray "Restart Service") resets backoff — this isn't a crash. */
  restart() {
    this.restartAttempt = 0;
    if (this.child) {
      this.child.once("exit", () => this.start());
      this.stop();
    } else {
      this.start();
    }
  }

  quit() {
    this.isQuitting = true;
    this.stop();
  }
}

module.exports = ServerManager;
