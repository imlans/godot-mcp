import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const CLI_PATH = join(PROJECT_ROOT, ".godot-mcp", "build", "cli.js");
const MCP_PORT = 9090;


export async function withOwnedMcpSession(body, options = {}) {
	const existingOwner = await getListeningPid(MCP_PORT);
	if (existingOwner !== null) {
		throw new Error(`MCP_PORT_OWNED_BY_EXTERNAL_PID:${existingOwner}`);
	}

	const revisionBefore = await captureRevision();
	const godotPath = resolveGodotPath(options.godotPath ?? process.env.GODOT_PATH);
	const logDir = join(PROJECT_ROOT, "temp", "runtime");
	mkdirSync(logDir, { recursive: true });
	const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
	const stdoutPath = join(logDir, `mcp_owned_${stamp}_stdout.log`);
	const stderrPath = join(logDir, `mcp_owned_${stamp}_stderr.log`);
	const stdout = createWriteStream(stdoutPath, { flags: "wx" });
	const stderr = createWriteStream(stderrPath, { flags: "wx" });
	const child = spawn(
		godotPath,
		["--headless", "--path", PROJECT_ROOT, "res://scenes/main_menu.tscn"],
		{
			cwd: PROJECT_ROOT,
			env: { ...process.env, GODOT_PATH: godotPath },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	child.stdout.pipe(stdout);
	child.stderr.pipe(stderr);
	const session = {
		pid: child.pid,
		projectRoot: PROJECT_ROOT,
		revision: revisionBefore,
		stdoutPath,
		stderrPath,
		execIngame,
		assertOwnership: () => assertOwnedListener(child.pid),
	};

	try {
		await waitForOwnedConnection(child);
		const baselineState = await execIngame("get_game_state", {});
		if (!isStructuredGameState(baselineState)) {
			throw new Error("MCP_GAME_STATE_NOT_STRUCTURED");
		}
		const result = await body(session, baselineState);
		await assertOwnedListener(child.pid);
		const revisionAfter = await captureRevision();
		if (
			revisionAfter.head !== revisionBefore.head
			|| revisionAfter.worktreeDigest !== revisionBefore.worktreeDigest
		) {
			throw new Error("MCP_SESSION_REVISION_CHANGED");
		}
		return {
			success: true,
			ownedPid: child.pid,
			revision: revisionBefore,
			baselineState,
			result,
			stdoutPath,
			stderrPath,
		};
	} finally {
		await stopOwnedProcess(child);
		stdout.end();
		stderr.end();
	}
}


export async function execIngame(tool, args, timeoutMs = 30000) {
	const envelope = await execCli(
		["ingame", "exec", "--tool", tool, "--args", JSON.stringify(args)],
		timeoutMs,
	);
	const content = envelope?.data?.content;
	if (!Array.isArray(content) || typeof content[0]?.text !== "string") {
		throw new Error(`MCP_COMMAND_NO_CONTENT:${tool}`);
	}
	const text = content[0].text;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}


export async function getListeningPid(port = MCP_PORT) {
	if (process.platform !== "win32") {
		throw new Error("OWNED_MCP_SESSION_WINDOWS_ONLY");
	}
	const { stdout } = await execFileAsync(
		"netstat.exe",
		["-ano", "-p", "tcp"],
		{ cwd: PROJECT_ROOT, windowsHide: true },
	);
	for (const line of stdout.split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		if (
			fields.length >= 5
			&& fields[0].toUpperCase() === "TCP"
			&& fields[1].endsWith(`:${port}`)
			&& fields[3].toUpperCase() === "LISTENING"
		) {
			const pid = Number.parseInt(fields[4], 10);
			if (Number.isInteger(pid) && pid > 0) {
				return pid;
			}
		}
	}
	return null;
}


async function execCli(args, timeoutMs) {
	const { stdout } = await execFileAsync(
		process.execPath,
		[CLI_PATH, ...args],
		{
			cwd: PROJECT_ROOT,
			env: { ...process.env },
			timeout: timeoutMs,
			windowsHide: true,
			maxBuffer: 4 * 1024 * 1024,
		},
	);
	const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		try {
			return JSON.parse(lines[index]);
		} catch {
			// CLI 可能在 JSON 前输出诊断文本，继续向前寻找最后一个 JSON 行。
		}
	}
	throw new Error("MCP_CLI_RETURNED_NO_JSON");
}


async function waitForOwnedConnection(child) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`OWNED_GODOT_EXITED_EARLY:${child.exitCode}`);
		}
		const owner = await getListeningPid(MCP_PORT);
		if (owner !== null && owner !== child.pid) {
			throw new Error(`MCP_PORT_STOLEN_BY_EXTERNAL_PID:${owner}`);
		}
		if (owner === child.pid) {
			try {
				const status = await execCli(["ingame", "status"], 5000);
				if (status?.success === true && status?.data?.connected === true) {
					return;
				}
			} catch {
				// transport 尚未完成连接，继续等待。
			}
		}
		await delay(250);
	}
	throw new Error("OWNED_MCP_CONNECTION_TIMEOUT");
}


async function assertOwnedListener(expectedPid) {
	const owner = await getListeningPid(MCP_PORT);
	if (owner !== expectedPid) {
		throw new Error(`MCP_LISTENER_OWNERSHIP_CHANGED:${owner ?? "none"}`);
	}
}


async function captureRevision() {
	const head = (
		await execFileAsync("git.exe", ["rev-parse", "HEAD"], {
			cwd: PROJECT_ROOT,
			windowsHide: true,
		})
	).stdout.trim();
	const porcelain = (
		await execFileAsync("git.exe", ["status", "--porcelain=v1", "-z"], {
			cwd: PROJECT_ROOT,
			windowsHide: true,
			encoding: "buffer",
			maxBuffer: 8 * 1024 * 1024,
		})
	).stdout;
	return {
		head,
		worktreeDigest: createHash("sha256").update(porcelain).digest("hex"),
	};
}


function resolveGodotPath(candidate) {
	const raw = candidate || "C:\\Code\\Godot_v4.6.3.exe";
	return raw.toLowerCase().endsWith("_console.exe")
		? raw.slice(0, -"_console.exe".length) + ".exe"
		: raw;
}


function isStructuredGameState(value) {
	return (
		value !== null
		&& typeof value === "object"
		&& Number.isInteger(value.current_state_value)
		&& typeof value.current_state_name === "string"
	);
}


async function stopOwnedProcess(child) {
	if (child.exitCode !== null) {
		return;
	}
	child.kill();
	const exited = await Promise.race([
		new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
		delay(5000).then(() => false),
	]);
	if (!exited && child.exitCode === null && process.platform === "win32") {
		await execFileAsync(
			"taskkill.exe",
			["/PID", String(child.pid), "/T", "/F"],
			{ cwd: PROJECT_ROOT, windowsHide: true },
		);
	}
}


function delay(ms) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
