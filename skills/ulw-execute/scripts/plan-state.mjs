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
// The plan file is never rewritten from a read result: `tick` selects one task row
// inside the canonical `## Todos` / `## Final verification wave` sections, re-reads
// the file, and refuses (exit 5) if another writer changed it. It then changes EXACTLY
// ONE status byte in place, re-reads the file, and requires (a) the same byte length,
// (b) exactly one differing byte at the checkbox offset, and (c) the expected content.
// On any mismatch it rolls that one byte back and exits 4. Refusals (exit 2/3/4/5)
// never leave the file rewritten from a stale snapshot.
//
// Exit codes: 0 ok (including "already at target"); 2 row not found; 3 ambiguous
// (2+ matching rows); 4 post-write self-check failed and the single status byte was
// rolled back; 5 usage/IO/validation, including a plan changed by another writer.

import { appendFileSync, closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The harness `read` tool caps output at 50 KiB; a plan bigger than this is normal
// and executable, it just must never be reconstructed from a capped read.
export const READ_CAP_BYTES = 50 * 1024;

const DEFAULT_LEDGER_PATH = join(".dsh", "ulw", "ulw-execute", "ledger.jsonl");
// Canonical task sections emitted by the ulw-plan templates (heading text compared
// case-insensitively). Only column-zero rows inside them are executable tasks when
// the plan declares H2 sections at all.
const TASK_SECTION_TITLES = new Set(["todos", "final verification wave"]);
const ROW_RE = /^- \[([ x~])\] (\d+|F\d+)\. /;
const HEADING_RE = /^(#{1,6})(?:[ \t]+(.*))?$/;
const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^( {0,3})(`{3,}|~{3,})[ \t\r]*$/;
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

function headingOf(line) {
	const match = HEADING_RE.exec(line);
	if (!match) return null;
	const title = (match[2] ?? "").replace(/\r$/, "").replace(/[ \t]+#+[ \t]*$/, "").trim();
	return { level: match[1].length, title };
}

function fenceOpening(line) {
	const match = FENCE_OPEN_RE.exec(line);
	if (!match) return null;
	if (match[2][0] === "`" && match[3].includes("`")) return null;
	return { char: match[2][0], length: match[2].length };
}

function fenceClosing(line, fence) {
	const match = FENCE_CLOSE_RE.exec(line);
	return Boolean(match) && match[2][0] === fence.char && match[2].length >= fence.length;
}

function opensHtmlComment(line) {
	let index = 0;
	for (;;) {
		const start = line.indexOf("<!--", index);
		if (start === -1) return false;
		const end = line.indexOf("-->", start + 4);
		if (end === -1) return true;
		index = end + 3;
	}
}

// Scan the file as bytes. A row must be a column-zero checklist line; fenced code
// blocks (including info strings and unclosed/nested fences), HTML comments, block
// quotes, indented code, and nested lists never contribute rows. Headings only count
// outside those constructs. When the document declares H2 sections, only rows inside
// the canonical task sections are executable; flat plans without H2 headings keep the
// historical whole-file row scan. The status byte is always at lineStart + 3 because
// the prefix is ASCII.
function scanDocument(buffer) {
	const rows = [];
	let hasH2 = false;
	let inTaskSection = false;
	let fence = null;
	let comment = false;
	let lineStart = 0;
	let line = 1;
	for (;;) {
		const newline = buffer.indexOf(10, lineStart);
		const lineEnd = newline === -1 ? buffer.length : newline;
		const raw = buffer.subarray(lineStart, lineEnd).toString("utf8");
		// A UTF-8 BOM is metadata, not content: ignore it when classifying the first
		// line, but keep its three bytes in every row offset.
		const bom = lineStart === 0 && raw.charCodeAt(0) === 0xfeff ? 3 : 0;
		const text = bom === 0 ? raw : raw.slice(1);
		let structural = false;
		if (fence !== null) {
			if (fenceClosing(text, fence)) fence = null;
			structural = true;
		} else if (comment) {
			if (text.includes("-->")) comment = false;
			structural = true;
		} else {
			const opening = fenceOpening(text);
			if (opening !== null) {
				fence = opening;
				structural = true;
			} else if (opensHtmlComment(text)) {
				comment = true;
			}
		}
		if (!structural) {
			const heading = headingOf(text);
			if (heading !== null) {
				if (heading.level === 2) hasH2 = true;
				if (heading.level <= 2) {
					inTaskSection = heading.level === 2 && TASK_SECTION_TITLES.has(heading.title.toLowerCase());
				}
			} else {
				const match = ROW_RE.exec(text);
				if (match) {
					rows.push({ id: match[2], status: match[1], line, offset: lineStart + bom + 3, task: inTaskSection });
				}
			}
		}
		if (newline === -1) break;
		lineStart = newline + 1;
		line += 1;
	}
	return { rows, hasH2 };
}

function selectedRows(scan) {
	return scan.hasH2 ? scan.rows.filter((row) => row.task) : scan.rows;
}

export function parseRows(content) {
	return selectedRows(scanDocument(toBuffer(content))).map(({ id, status, line }) => ({ id, status, line }));
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
	const matches = selectedRows(scanDocument(buffer)).filter((row) => row.id === rowId);
	if (matches.length === 0) throw new PlanStateError(`row not found: ${rowId}`, 2);
	if (matches.length > 1) {
		throw new PlanStateError(`ambiguous row id ${rowId}: ${matches.length} column-zero rows match`, 3);
	}
	const row = matches[0];
	if (row.status === to) {
		return { changed: false, rowId, status: to, from: row.status, line: row.line, offset: row.offset, content: buffer };
	}
	const updated = Buffer.from(buffer);
	updated[row.offset] = to.charCodeAt(0);
	return { changed: true, rowId, status: to, from: row.status, line: row.line, offset: row.offset, content: updated };
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
		const content = readFileSync(planPath);
		return { bytes: content.length, mode: stat.mode & 0o7777, content, dev: stat.dev, ino: stat.ino };
	} catch (err) {
		throw new PlanStateError(`cannot read plan ${planPath}: ${err instanceof Error ? err.message : String(err)}`, 5);
	}
}

function concurrentRefusal(planPath) {
	return `plan changed while ticking ${planPath}; refusing to overwrite concurrent edits (no bytes written)`;
}

// The snapshot must still be the plan on disk before a single byte is written. A
// different inode means the path was replaced; different bytes mean another writer
// appended or edited. Both are refusals, so the concurrent state stays untouched.
function verifyUnchanged(planPath, snapshot) {
	const fresh = readPlan(planPath);
	if (fresh.dev !== snapshot.dev || fresh.ino !== snapshot.ino || !fresh.content.equals(snapshot.content)) {
		throw new PlanStateError(concurrentRefusal(planPath), 5);
	}
	return fresh;
}

// Change exactly one status byte in place. No snapshot is ever written back: the
// descriptor is re-read immediately before writeSync, so a writer that wins the race
// makes this refuse instead of corrupting or discarding their bytes.
function writeStatusByte(planPath, snapshot, offset, expectedStatus, targetStatus) {
	let fd;
	try {
		fd = openSync(planPath, "r+");
	} catch (err) {
		throw new PlanStateError(`cannot open ${planPath} for writing: ${err instanceof Error ? err.message : String(err)}`, 5);
	}
	try {
		const stat = fstatSync(fd);
		if (stat.dev !== snapshot.dev || stat.ino !== snapshot.ino) throw new PlanStateError(concurrentRefusal(planPath), 5);
		const current = readFileSync(fd);
		if (!current.equals(snapshot.content)) throw new PlanStateError(concurrentRefusal(planPath), 5);
		if (current[offset] !== expectedStatus.charCodeAt(0)) {
			throw new PlanStateError(`unexpected status byte at ${offset} in ${planPath}; refusing to write`, 5);
		}
		writeSync(fd, Buffer.from(targetStatus), 0, 1, offset);
		fsyncSync(fd);
	} finally {
		try {
			closeSync(fd);
		} catch {
			// The descriptor was already closed.
		}
	}
}

// Undo only our own status byte. Returns "restored" when the plan is byte-identical
// to the snapshot again, "rolled-back" when concurrent edits remain, and null when
// the path is no longer the inode we wrote (so there is nothing safe to undo).
function rollbackStatusByte(planPath, snapshot, offset, writtenStatus, originalStatus) {
	let fd;
	try {
		fd = openSync(planPath, "r+");
	} catch {
		return null;
	}
	try {
		const stat = fstatSync(fd);
		if (stat.dev !== snapshot.dev || stat.ino !== snapshot.ino) return null;
		const current = readFileSync(fd);
		if (current[offset] !== writtenStatus.charCodeAt(0)) return null;
		writeSync(fd, Buffer.from(originalStatus), 0, 1, offset);
		fsyncSync(fd);
	} catch {
		return null;
	} finally {
		try {
			closeSync(fd);
		} catch {
			// The descriptor was already closed.
		}
	}
	try {
		return readFileSync(planPath).equals(snapshot.content) ? "restored" : "rolled-back";
	} catch {
		return "rolled-back";
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
	const fresh = verifyUnchanged(planPath, plan);
	if (!result.changed) {
		const record = { plan: planPath, rowId, status: to, changed: false, line: result.line };
		process.stdout.write(json ? `${JSON.stringify(record)}\n` : `already ${rowId} ${to}\n`);
		return 0;
	}
	writeStatusByte(planPath, fresh, result.offset, result.from, to);
	let actual = null;
	try {
		actual = readFileSync(planPath);
	} catch {
		actual = null;
	}
	if (actual === null || !verifyTick(plan.content, result.content, actual, result.offset)) {
		const rollback = rollbackStatusByte(planPath, plan, result.offset, to, result.from);
		const suffix =
			rollback === "restored"
				? "original bytes restored"
				: rollback === "rolled-back"
					? "status byte rolled back; concurrent edits remain - inspect the plan"
					: "restore skipped because the file changed again - inspect the plan";
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
	"tick flips one task row in ## Todos / ## Final verification wave, refuses when another writer changed",
	"the plan, and otherwise writes exactly that one status byte without rewriting the rest of the file.",
	"exit codes: 0 ok (including already at target); 2 row not found; 3 ambiguous row id;",
	"            4 post-write self-check failed and the single status byte was rolled back;",
	"            5 usage/IO/validation (including a plan changed by another writer; nothing written)",
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
