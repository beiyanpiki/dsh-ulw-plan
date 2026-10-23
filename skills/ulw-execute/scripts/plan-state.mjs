#!/usr/bin/env node
// plan-state.mjs - capped-read-safe state for ulw plan files.
//
// Zero external dependencies (node:fs/path/process/url builtins only) so it runs
// byte-identically under `node` and `bun` with no install step, mirroring
// skills/ulw-plan/scripts/scaffold-plan.mjs.
//
// Usage:
//   plan-state.mjs status <plan.md> [--json]
//   plan-state.mjs tick <plan.md> <rowId> [--to x|~] [--json]
//   plan-state.mjs ledger <plan.md> --event <e> --task <id> --session-id <dsh:|codex:id>
//       --commands <cmd>... --artifact <path>... --adversarial <class=result>...
//       --cleanup <receipt>... --attempt <n> --checkpoint-opened-at <ISO>
//       [--ledger <path>] [--extra <json-object>]
//
// The plan file is never rewritten from a read result: `tick` changes EXACTLY ONE
// status byte, in one column-zero row, through a temp file + chmod + rename, then
// re-reads the file from disk and requires (a) the same byte length, (b) exactly one
// differing byte at the checkbox offset, and (c) the expected content. On any
// mismatch it restores the original bytes and exits 4. Refusals (exit 2/3/5) never
// write, so an ambiguous plan is left byte-identical.
//
// Exit codes: 0 ok (including "already at target"); 2 row not found; 3 ambiguous
// (2+ matching rows); 4 post-write self-check failed and the original bytes were
// restored; 5 usage/IO/validation.

import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The harness `read` tool caps output at 50 KiB; a plan bigger than this is normal
// and executable, it just must never be reconstructed from a capped read.
export const READ_CAP_BYTES = 50 * 1024;

const DEFAULT_LEDGER_PATH = join(".dsh", "ulw", "ulw-execute", "ledger.jsonl");
const ROW_RE = /^- \[([ x~])\] (\d+|F\d+)\. /;
const SESSION_RE = /^(dsh|codex):\S+$/;
const ADVERSARIAL_RE = /^([a-z][a-z0-9_]*)=(.+)$/;
const LEDGER_FIELDS = ["event", "plan", "task", "session_id", "commands", "artifact", "adversarial_classes", "cleanup", "attempt", "checkpoint_opened_at"];

export class PlanStateError extends Error {
	constructor(message, exitCode = 5) {
		super(message);
		this.name = "PlanStateError";
		this.exitCode = exitCode;
	}
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBuffer(content) {
	if (Buffer.isBuffer(content)) return content;
	if (typeof content === "string") return Buffer.from(content, "utf8");
	throw new PlanStateError("plan content must be a string or a Buffer", 5);
}

// Scan the file as bytes: a row is a line whose FIRST characters are the checklist
// prefix, so indented, quoted, or nested checkboxes never match. The status byte is
// always at lineStart + 3 because the prefix is ASCII.
function scanRows(buffer) {
	const rows = [];
	let lineStart = 0;
	let line = 1;
	for (;;) {
		const newline = buffer.indexOf(10, lineStart);
		const lineEnd = newline === -1 ? buffer.length : newline;
		const match = ROW_RE.exec(buffer.subarray(lineStart, lineEnd).toString("utf8"));
		if (match) rows.push({ id: match[2], status: match[1], line, offset: lineStart + 3 });
		if (newline === -1) break;
		lineStart = newline + 1;
		line += 1;
	}
	return rows;
}

export function parseRows(content) {
	return scanRows(toBuffer(content)).map(({ id, status, line }) => ({ id, status, line }));
}

export function summarize(content) {
	const rows = parseRows(content);
	const done = rows.filter((row) => row.status === "x").length;
	const blocked = rows.filter((row) => row.status === "~").length;
	const open = rows.filter((row) => row.status === " ").length;
	const next = rows.find((row) => row.status === " ");
	return { total: rows.length, done, open, blocked, next: next ? next.id : "-", line: next ? next.line : "-" };
}

export function formatStatus(record) {
	const capped = record.bytes > READ_CAP_BYTES ? "yes" : "no";
	return `plan=${record.plan} bytes=${record.bytes} capped=${capped} total=${record.total} done=${record.done} open=${record.open} blocked=${record.blocked} next=${record.next} line=${record.line}`;
}

// Pure one-row flip. Returns the new bytes; raises exit 2 for 0 matches and exit 3
// for 2+ matches, before anything can be written.
export function applyTick(content, rowId, to = "x") {
	if (to !== "x" && to !== "~") throw new PlanStateError('--to must be "x" or "~"', 5);
	if (typeof rowId !== "string" || rowId === "") throw new PlanStateError("row id must be a non-empty string", 5);
	const buffer = toBuffer(content);
	const matches = scanRows(buffer).filter((row) => row.id === rowId);
	if (matches.length === 0) throw new PlanStateError(`row not found: ${rowId}`, 2);
	if (matches.length > 1) {
		throw new PlanStateError(`ambiguous row id ${rowId}: ${matches.length} column-zero rows match`, 3);
	}
	const row = matches[0];
	if (row.status === to) {
		return { changed: false, rowId, status: to, line: row.line, offset: row.offset, content: buffer };
	}
	const updated = Buffer.from(buffer);
	updated[row.offset] = to.charCodeAt(0);
	return { changed: true, rowId, status: to, line: row.line, offset: row.offset, content: updated };
}

function requireText(value, flag) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new PlanStateError(`${flag} is required`, 5);
	}
	return value;
}

function requireValues(values, flag) {
	if (!Array.isArray(values) || values.length === 0) {
		throw new PlanStateError(`${flag} needs at least one value`, 5);
	}
	for (const value of values) {
		if (typeof value !== "string" || value.trim() === "") {
			throw new PlanStateError(`${flag} values must be non-empty strings`, 5);
		}
	}
	return values.slice();
}

function normalizeAdversarial(values) {
	if (!Array.isArray(values) || values.length === 0) {
		throw new PlanStateError("--adversarial needs at least one value", 5);
	}
	return values.map((value) => {
		if (isPlainObject(value)) {
			const name = requireText(value.class, "--adversarial class");
			const result = requireText(value.result, "--adversarial result");
			if (!/^[a-z][a-z0-9_]*$/.test(name)) {
				throw new PlanStateError(`--adversarial class is not a token: ${name}`, 5);
			}
			return { class: name, result };
		}
		if (typeof value !== "string") {
			throw new PlanStateError("--adversarial values must be <class>=<result> strings", 5);
		}
		const match = ADVERSARIAL_RE.exec(value);
		if (!match) throw new PlanStateError(`--adversarial must look like <class>=<result>: ${value}`, 5);
		return { class: match[1], result: match[2] };
	});
}

function normalizeExtra(extra) {
	if (extra === undefined || extra === null) return {};
	let value = extra;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			throw new PlanStateError("--extra must be valid JSON", 5);
		}
	}
	if (!isPlainObject(value)) throw new PlanStateError("--extra must be a flat JSON object", 5);
	for (const [key, item] of Object.entries(value)) {
		if (LEDGER_FIELDS.includes(key)) throw new PlanStateError(`--extra may not set ${key}`, 5);
		if (item === null) continue;
		const kind = typeof item;
		if (kind !== "string" && kind !== "number" && kind !== "boolean") {
			throw new PlanStateError(`--extra must be flat; ${key} is not a primitive`, 5);
		}
	}
	return value;
}

// Validate every mandated ledger field in-process and return the entry to append.
// No field is ever parsed out of shell-assembled JSON.
export function validateLedgerEntry(input) {
	if (!isPlainObject(input)) throw new PlanStateError("ledger entry must be an object", 5);
	const event = requireText(input.event, "--event");
	const plan = requireText(input.plan, "--plan");
	const task = requireText(input.task, "--task");
	const sessionId = requireText(input.session_id ?? input.sessionId, "--session-id");
	if (!SESSION_RE.test(sessionId)) {
		throw new PlanStateError("--session-id must match dsh:<id> or codex:<id>", 5);
	}
	const commands = requireValues(input.commands, "--commands");
	const artifact = requireValues(input.artifact, "--artifact");
	const cleanup = requireValues(input.cleanup, "--cleanup");
	const adversarialClasses = normalizeAdversarial(input.adversarial_classes ?? input.adversarial);
	const attempt = typeof input.attempt === "number" ? input.attempt : Number(input.attempt);
	if (!Number.isInteger(attempt) || attempt < 1) {
		throw new PlanStateError("--attempt must be a positive integer", 5);
	}
	const opened = requireText(input.checkpoint_opened_at ?? input.checkpointOpenedAt, "--checkpoint-opened-at");
	if (!Number.isFinite(Date.parse(opened))) {
		throw new PlanStateError("--checkpoint-opened-at must be a parseable timestamp", 5);
	}
	const entry = {
		event,
		plan,
		task,
		session_id: sessionId,
		commands,
		artifact,
		adversarial_classes: adversarialClasses,
		cleanup,
		attempt,
		checkpoint_opened_at: opened,
	};
	for (const [key, value] of Object.entries(normalizeExtra(input.extra))) entry[key] = value;
	return entry;
}

function readPlan(planPath) {
	try {
		const stat = statSync(planPath);
		return { bytes: stat.size, mode: stat.mode & 0o7777, content: readFileSync(planPath) };
	} catch (err) {
		throw new PlanStateError(`cannot read plan ${planPath}: ${err instanceof Error ? err.message : String(err)}`, 5);
	}
}

function writeAtomic(target, bytes, mode) {
	const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`);
	try {
		writeFileSync(temp, bytes, { mode });
		chmodSync(temp, mode);
		renameSync(temp, target);
	} catch (err) {
		try {
			unlinkSync(temp);
		} catch {
			// The temp file was never created or was already renamed into place.
		}
		throw new PlanStateError(`cannot write ${target} atomically: ${err instanceof Error ? err.message : String(err)}`, 5);
	}
}

function verifyTick(original, expected, actual, offset) {
	if (actual.length !== original.length) return false;
	let differences = 0;
	let firstDifference = -1;
	for (let i = 0; i < actual.length; i += 1) {
		if (actual[i] !== original[i]) {
			differences += 1;
			if (firstDifference === -1) firstDifference = i;
		}
	}
	return differences === 1 && firstDifference === offset && actual.equals(expected);
}

function restoreOriginal(target, original, mode) {
	try {
		writeAtomic(target, original, mode);
		return readFileSync(target).equals(original);
	} catch {
		return false;
	}
}

function takeValue(args, index, flag) {
	const value = args[index];
	if (value === undefined) throw new PlanStateError(`missing value for ${flag}`, 5);
	return value;
}

function runStatus(args) {
	let planPath;
	let json = false;
	for (const arg of args) {
		if (arg === "--json") json = true;
		else if (arg.startsWith("--")) throw new PlanStateError(`unknown flag: ${arg}`, 5);
		else if (planPath === undefined) planPath = arg;
		else throw new PlanStateError(`unexpected argument: ${arg}`, 5);
	}
	if (planPath === undefined) throw new PlanStateError("usage: plan-state.mjs status <plan.md> [--json]", 5);
	const plan = readPlan(planPath);
	const summary = summarize(plan.content);
	const record = { plan: planPath, bytes: plan.bytes, capped: plan.bytes > READ_CAP_BYTES, ...summary };
	process.stdout.write(json ? `${JSON.stringify(record)}\n` : `${formatStatus(record)}\n`);
	return 0;
}

function runTick(args) {
	let planPath;
	let rowId;
	let to = "x";
	let json = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--json") json = true;
		else if (arg === "--to") {
			to = takeValue(args, i + 1, "--to");
			i += 1;
		} else if (arg.startsWith("--to=")) to = arg.slice("--to=".length);
		else if (arg.startsWith("--")) throw new PlanStateError(`unknown flag: ${arg}`, 5);
		else if (planPath === undefined) planPath = arg;
		else if (rowId === undefined) rowId = arg;
		else throw new PlanStateError(`unexpected argument: ${arg}`, 5);
	}
	if (planPath === undefined || rowId === undefined) {
		throw new PlanStateError("usage: plan-state.mjs tick <plan.md> <rowId> [--to x|~] [--json]", 5);
	}
	if (to !== "x" && to !== "~") throw new PlanStateError('--to must be "x" or "~"', 5);
	const plan = readPlan(planPath);
	const result = applyTick(plan.content, rowId, to);
	if (!result.changed) {
		const record = { plan: planPath, rowId, status: to, changed: false, line: result.line };
		process.stdout.write(json ? `${JSON.stringify(record)}\n` : `already ${rowId} ${to}\n`);
		return 0;
	}
	writeAtomic(planPath, result.content, plan.mode);
	let actual = null;
	try {
		actual = readFileSync(planPath);
	} catch {
		actual = null;
	}
	if (actual === null || !verifyTick(plan.content, result.content, actual, result.offset)) {
		const restored = restoreOriginal(planPath, plan.content, plan.mode);
		const suffix = restored ? "original bytes restored" : "restore also failed - inspect the plan";
		throw new PlanStateError(`post-write self-check failed for ${planPath}; ${suffix}`, 4);
	}
	const record = { plan: planPath, rowId, status: to, changed: true, line: result.line };
	process.stdout.write(json ? `${JSON.stringify(record)}\n` : `ticked ${rowId} ${to}\n`);
	return 0;
}

function runLedger(args) {
	let planPath;
	const values = { commands: [], artifact: [], adversarial: [], cleanup: [] };
	let event;
	let task;
	let sessionId;
	let attempt;
	let checkpointOpenedAt;
	let ledgerPath;
	let extra;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--event") event = takeValue(args, ++i, "--event");
		else if (arg === "--task") task = takeValue(args, ++i, "--task");
		else if (arg === "--session-id") sessionId = takeValue(args, ++i, "--session-id");
		else if (arg === "--attempt") attempt = takeValue(args, ++i, "--attempt");
		else if (arg === "--checkpoint-opened-at") checkpointOpenedAt = takeValue(args, ++i, "--checkpoint-opened-at");
		else if (arg === "--ledger") ledgerPath = takeValue(args, ++i, "--ledger");
		else if (arg === "--extra") extra = takeValue(args, ++i, "--extra");
		else if (arg === "--commands" || arg === "--artifact" || arg === "--adversarial" || arg === "--cleanup") {
			const key = arg.slice(2);
			let consumed = 0;
			while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
				values[key].push(args[i + 1]);
				i += 1;
				consumed += 1;
			}
			if (consumed === 0) throw new PlanStateError(`${arg} needs at least one value`, 5);
		} else if (arg.startsWith("--")) throw new PlanStateError(`unknown flag: ${arg}`, 5);
		else if (planPath === undefined) planPath = arg;
		else throw new PlanStateError(`unexpected argument: ${arg}`, 5);
	}
	if (planPath === undefined) {
		throw new PlanStateError("usage: plan-state.mjs ledger <plan.md> --event <event> --task <id> --session-id <dsh:|codex:id> ...", 5);
	}
	const entry = validateLedgerEntry({
		event,
		plan: planPath,
		task,
		sessionId,
		commands: values.commands,
		artifact: values.artifact,
		adversarial: values.adversarial,
		cleanup: values.cleanup,
		attempt,
		checkpointOpenedAt,
		extra,
	});
	const target = ledgerPath === undefined ? resolve(process.cwd(), DEFAULT_LEDGER_PATH) : resolve(ledgerPath);
	let existing = "";
	try {
		existing = readFileSync(target, "utf8");
	} catch (err) {
		if (!err || err.code !== "ENOENT") {
			throw new PlanStateError(`cannot read ledger ${target}: ${err instanceof Error ? err.message : String(err)}`, 5);
		}
	}
	const payload = JSON.stringify(entry);
	try {
		mkdirSync(dirname(target), { recursive: true });
		const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
		appendFileSync(target, `${prefix}${payload}\n`, "utf8");
	} catch (err) {
		throw new PlanStateError(`cannot append to ledger ${target}: ${err instanceof Error ? err.message : String(err)}`, 5);
	}
	let readBack;
	let last;
	try {
		readBack = readFileSync(target, "utf8");
		const lines = readBack.split("\n").filter((item) => item.trim() !== "");
		last = JSON.parse(lines[lines.length - 1]);
	} catch (err) {
		throw new PlanStateError(`ledger read-back failed for ${target}: ${err instanceof Error ? err.message : String(err)}`, 4);
	}
	if (JSON.stringify(last) !== payload) {
		throw new PlanStateError(`ledger read-back mismatch for ${target}: the appended line does not match the entry`, 4);
	}
	const count = readBack.split("\n").filter((item) => item.trim() !== "").length;
	process.stdout.write(`ledger=${target} line=${count} event=${entry.event} task=${entry.task}\n`);
	return 0;
}

const USAGE = [
	"usage:",
	"  plan-state.mjs status <plan.md> [--json]",
	"  plan-state.mjs tick <plan.md> <rowId> [--to x|~] [--json]",
	"  plan-state.mjs ledger <plan.md> --event <event> --task <id> --session-id <dsh:|codex:id>",
	"      --commands <cmd>... --artifact <path>... --adversarial <class=result>...",
	"      --cleanup <receipt>... --attempt <n> --checkpoint-opened-at <ISO>",
	"      [--ledger <path>] [--extra <json-object>]",
	"",
	"status prints: plan=<path> bytes=<n> capped=<yes|no> total=<n> done=<n> open=<n> blocked=<n> next=<rowId|-> line=<n|->",
	"tick flips exactly one column-zero row and verifies the change on disk; it never rewrites the rest of the plan.",
	"exit codes: 0 ok (including already at target); 2 row not found; 3 ambiguous row id;",
	"            4 post-write self-check failed and the original bytes were restored; 5 usage/IO/validation",
].join("\n");

function main(argv) {
	const command = argv[2];
	if (command === undefined) throw new PlanStateError(USAGE, 5);
	if (command === "--help" || command === "-h" || command === "help") {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const rest = argv.slice(3);
	if (command === "status") return runStatus(rest);
	if (command === "tick") return runTick(rest);
	if (command === "ledger") return runLedger(rest);
	throw new PlanStateError(`unknown command: ${command}\n${USAGE}`, 5);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.exitCode = main(process.argv);
	} catch (err) {
		const exitCode = err instanceof PlanStateError ? err.exitCode : 5;
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = exitCode;
	}
}
