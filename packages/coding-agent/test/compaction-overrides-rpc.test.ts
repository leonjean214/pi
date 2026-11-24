import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const sourceResolverUrl = new URL("../src/experimental/source-resolver.ts", import.meta.url).href;
const summaryDelayMs = 1500;

type ProbeEvent = {
	type: string;
	id?: string;
	success?: boolean;
	error?: string;
	reason?: string;
	aborted?: boolean;
	result?: { summary: string; tokensBefore: number };
};

async function startProvider() {
	const requests: { kind: "prompt" | "summary"; totalTokens: number; receivedAt: number; sentAt?: number }[] = [];
	let turns = 0;
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const summary = body.includes("Create a structured context checkpoint summary");
		const totalTokens = summary ? 100 : ([22_000, 24_000, 4000][turns++] ?? 4000);
		const record = {
			kind: summary ? ("summary" as const) : ("prompt" as const),
			totalTokens,
			receivedAt: Date.now(),
			sentAt: undefined as number | undefined,
		};
		requests.push(record);
		if (summary) await delay(summaryDelayMs);
		const chunk = (data: object) =>
			`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", model: "fake-model", ...data })}\n\n`;
		record.sentAt = Date.now();
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.write(chunk({ choices: [{ index: 0, delta: { content: summary ? "Probe summary" : "Probe reply" } }] }));
		response.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
		response.write(
			chunk({
				choices: [],
				usage: { prompt_tokens: totalTokens - 1, completion_tokens: 1, total_tokens: totalTokens },
			}),
		);
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a loopback TCP address");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		close: () => {
			server.close();
			server.closeAllConnections();
		},
	};
}

async function runProbe(
	variant: "native" | "manual",
	verify: (probe: {
		prompt: (id: string) => Promise<ProbeEvent>;
		settle: () => Promise<ProbeEvent>;
		waitFor: (predicate: (event: ProbeEvent) => boolean) => Promise<ProbeEvent>;
		events: ProbeEvent[];
		requests: Awaited<ReturnType<typeof startProvider>>["requests"];
	}) => Promise<void>,
) {
	const provider = await startProvider();
	const root = mkdtempSync(join(tmpdir(), "pi-compaction-rpc-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const agentSettings = join(agentDir, "settings.json");
	const projectSettings = join(projectDir, ".pi", "settings.json");
	const settingsPaths = [agentSettings, projectSettings];
	const settingsFiles = () =>
		readdirSync(root, { recursive: true, encoding: "utf8" })
			.filter((path) => basename(path) === "settings.json")
			.sort();
	const events: ProbeEvent[] = [];
	const transcript: string[] = [];
	let stderr = "";
	try {
		mkdirSync(agentDir);
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					fake: {
						baseUrl: provider.baseUrl,
						api: "openai-completions",
						apiKey: "test",
						models: [{ id: "fake-model", contextWindow: 32_000, maxTokens: 2048 }],
					},
				},
			}),
		);
		writeFileSync(
			agentSettings,
			'{\n  "defaultProvider": "fake", "defaultModel": "fake-model",\n  "compaction": { "enabled": true, "reserveTokens": 4000, "keepRecentTokens": 2000 }\n}\n',
		);
		writeFileSync(projectSettings, '{\n  "quietStartup": true\n}\n');
		const before = settingsPaths.map((path) => readFileSync(path));
		const filesBefore = settingsFiles();
		const flags = [];
		if (variant === "native") {
			flags.push("--compaction-overrides", '{"fake/fake-model":{"reserveTokens":10000,"keepRecentTokens":2000}}');
		} else {
			const extension = join(root, "legacy.mjs");
			writeFileSync(
				extension,
				`export default function (pi) {
					let runs = 0;
					pi.on("agent_settled", (_event, ctx) => {
						if (++runs === 2) ctx.compact();
					});
				}`,
			);
			flags.push("-e", extension);
		}
		const child = spawn(
			process.execPath,
			["--import", sourceResolverUrl, cliPath, "--mode", "rpc", "--no-session", ...flags],
			{ cwd: projectDir, env: { ...process.env, [ENV_AGENT_DIR]: agentDir, PI_OFFLINE: "1" } },
		);
		child.stderr.setEncoding("utf8").on("data", (data: string) => {
			stderr += data;
		});
		const exited = new Promise<number | null>((resolve) => {
			child.on("error", (error) => {
				stderr += error.message;
			});
			child.once("close", resolve);
		});
		const lines = createInterface({ input: child.stdout });
		const iterator = lines[Symbol.asyncIterator]();
		const watchdog = setTimeout(() => child.kill("SIGKILL"), 30_000);
		const waitFor = async (predicate: (event: ProbeEvent) => boolean) => {
			for (;;) {
				const line = await iterator.next();
				if (line.done) throw new Error(`RPC stdout closed before the expected event. Stderr:\n${stderr}`);
				transcript.push(line.value);
				const event = JSON.parse(line.value) as ProbeEvent;
				events.push(event);
				if (predicate(event)) return event;
			}
		};
		const prompt = (id: string) => {
			// The recent turn must be large enough to retain it while summarizing the older turn.
			child.stdin.write(
				`${JSON.stringify({ type: "prompt", id, message: `Turn ${id}: ${"abcd ".repeat(1800)}` })}\n`,
			);
			return waitFor((event) => event.type === "response" && event.id === id);
		};
		try {
			await verify({
				prompt,
				settle: async () => {
					const afterResponse = events.length;
					const settled = await waitFor((event) => event.type === "agent_settled");
					// RPC acknowledges receipt; only the assistant turn proves the model completed successfully.
					expect(events.slice(afterResponse, -1), "Accepted prompt must finish with a model reply").toContainEqual(
						expect.objectContaining({
							type: "turn_end",
							message: expect.objectContaining({
								role: "assistant",
								stopReason: "stop",
								content: [{ type: "text", text: "Probe reply" }],
							}),
						}),
					);
					return settled;
				},
				waitFor,
				events,
				requests: provider.requests,
			});
			child.stdin.end();
			expect(await exited, stderr).toBe(0);
		} finally {
			clearTimeout(watchdog);
			lines.close();
			child.kill("SIGKILL");
			await exited;
		}
		const bytesUnchanged = settingsPaths.map((path, index) => readFileSync(path).equals(before[index]));
		const filesAfter = settingsFiles();
		const evidenceDir = process.env.PI_PROBE_EVIDENCE_DIR;
		if (evidenceDir) {
			mkdirSync(evidenceDir, { recursive: true });
			writeFileSync(join(evidenceDir, `${variant}.rpc.jsonl`), `${transcript.join("\n")}\n`);
			writeFileSync(
				join(evidenceDir, `${variant}.observations.json`),
				`${JSON.stringify({ requests: provider.requests, filesBefore, filesAfter, bytesUnchanged, stderr }, null, 2)}\n`,
			);
		}
		expect(bytesUnchanged).toEqual([true, true]);
		expect(filesAfter).toEqual(filesBefore);
	} finally {
		provider.close();
		rmSync(root, { recursive: true, force: true });
	}
}

it("completes native 22K threshold compaction before settling and completes prompt 3", async () => {
	await runProbe("native", async ({ prompt, settle, events, requests }) => {
		expect(await prompt("1")).toMatchObject({ success: true });
		const first = await settle();
		expect(first.aborted).toBe(false);
		expect(events.some((event) => event.type === "compaction_start")).toBe(false);

		expect(await prompt("2")).toMatchObject({ success: true });
		const second = await settle();
		expect(second.aborted).toBe(false);
		const compaction = events.filter((event) => event.type === "compaction_start" || event.type === "compaction_end");
		expect(compaction).toMatchObject([
			{ type: "compaction_start", reason: "threshold" },
			{
				type: "compaction_end",
				reason: "threshold",
				aborted: false,
				result: { summary: expect.stringContaining("Probe summary") },
			},
		]);
		expect(events.indexOf(compaction[1])).toBeLessThan(events.indexOf(second));

		expect(await prompt("3")).toMatchObject({ success: true });
		expect(await settle()).toMatchObject({ aborted: false });
		expect(requests.map(({ kind, totalTokens }) => [kind, totalTokens])).toEqual([
			["prompt", 22_000],
			["prompt", 24_000],
			["summary", 100],
			["prompt", 4000],
		]);
	});
}, 40_000);

it("rejects prompt 3 while the legacy agent_settled extension is compacting", async () => {
	await runProbe("manual", async ({ prompt, settle, waitFor, events, requests }) => {
		expect(await prompt("1")).toMatchObject({ success: true });
		await settle();
		expect(await prompt("2")).toMatchObject({ success: true });
		const second = await settle();
		const third = await prompt("3");
		expect(third).toMatchObject({
			success: false,
			error: "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
		});
		const end = await waitFor((event) => event.type === "compaction_end");
		expect(end).toMatchObject({ aborted: false, result: { summary: expect.stringContaining("Probe summary") } });
		expect(events.filter((event) => event.type === "compaction_start")).toMatchObject([{ reason: "manual" }]);
		expect(events.indexOf(end)).toBeGreaterThan(events.indexOf(second));
		expect(requests.map(({ kind }) => kind)).toEqual(["prompt", "prompt", "summary"]);
	});
}, 40_000);
