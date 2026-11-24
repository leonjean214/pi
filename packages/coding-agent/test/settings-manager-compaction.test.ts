import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

const model = { provider: "provider", id: "family/model" };
const modelKey = "provider/family/model";
const defaults = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };

// Regression coverage for #8133.
describe("compaction model overrides", () => {
	it("applies a CLI override for an empty provider ID without applying extra fields", () => {
		const parsed = parseArgs([
			"--compaction-overrides",
			'{"/local-model":{"reserveTokens":123,"keepRecentTokens":45,"enabled":false}}',
		]);
		expect(parsed.diagnostics).toEqual([]);
		const manager = SettingsManager.inMemory({}, { compactionModelOverrides: parsed.compactionOverrides });
		expect(manager.getCompactionSettings({ provider: "", id: "local-model" })).toEqual({
			enabled: true,
			reserveTokens: 123,
			keepRecentTokens: 45,
		});
	});

	it("uses defaults without compaction settings", () => {
		const manager = SettingsManager.inMemory();
		expect(manager.getCompactionSettings()).toEqual(defaults);
		expect(manager.getCompactionSettings(model)).toEqual(defaults);
	});

	it("resolves each field independently and keeps individual getters consistent", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				reserveTokens: 8192,
				keepRecentTokens: 10000,
				modelOverrides: { [modelKey]: { reserveTokens: 400000 } },
			},
		});
		expect(manager.getCompactionSettings(model)).toEqual({
			enabled: true,
			reserveTokens: 400000,
			keepRecentTokens: 10000,
		});
		expect(manager.getCompactionReserveTokens(model)).toBe(400000);
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(10000);
		expect(manager.getCompactionSettings()).toEqual({ enabled: true, reserveTokens: 8192, keepRecentTokens: 10000 });

		manager.applyOverrides({ compaction: { modelOverrides: { [modelKey]: { keepRecentTokens: 30000 } } } });
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(30000);
		expect(manager.getCompactionReserveTokens(model)).toBe(400000);
	});

	it("falls back to built-in defaults for missing fields", () => {
		const manager = SettingsManager.inMemory({
			compaction: { modelOverrides: { [modelKey]: { keepRecentTokens: 1024 } } },
		});
		expect(manager.getCompactionSettings(model)).toEqual({ ...defaults, keepRecentTokens: 1024 });
	});

	it("matches exact provider/model IDs, including IDs containing slashes", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				modelOverrides: {
					[modelKey]: { reserveTokens: 400000 },
					"provider/*": { reserveTokens: 1 },
					"family/model": { reserveTokens: 2 },
				},
			},
		});
		expect(manager.getCompactionReserveTokens(model)).toBe(400000);
		for (const other of [
			{ provider: "other", id: model.id },
			{ provider: model.provider, id: "other" },
			{ provider: model.provider, id: "family/Model" },
		]) {
			expect(manager.getCompactionSettings(other)).toEqual(defaults);
		}
	});

	it("merges project model overrides per field before resolving fallbacks", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				compaction: {
					reserveTokens: 8192,
					modelOverrides: {
						[modelKey]: { reserveTokens: 400000, keepRecentTokens: 30000 },
						"provider/other": { keepRecentTokens: 4096 },
					},
				},
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				compaction: { reserveTokens: 1024, modelOverrides: { [modelKey]: { keepRecentTokens: 2000 } } },
			}),
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings(model)).toEqual({
			enabled: true,
			reserveTokens: 400000,
			keepRecentTokens: 2000,
		});
		expect(manager.getCompactionSettings({ provider: "provider", id: "other" })).toEqual({
			enabled: true,
			reserveTokens: 1024,
			keepRecentTokens: 4096,
		});
		await manager.reload();
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(2000);
		manager.setProjectTrusted(false);
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(30000);
	});

	it("keeps process overrides through reload, trust changes and scoped saves without persisting them", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-compaction-settings-"));
		try {
			const cwd = join(root, "project");
			const agentDir = join(root, "agent");
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(agentDir);
			mkdirSync(projectDir, { recursive: true });
			const globalPath = join(agentDir, "settings.json");
			const projectPath = join(projectDir, "settings.json");
			const globalJson = JSON.stringify({ compaction: { reserveTokens: 8192 } });
			const projectJson = JSON.stringify({ compaction: { reserveTokens: 1024 } });
			writeFileSync(globalPath, globalJson);
			writeFileSync(projectPath, projectJson);
			const options = { compactionModelOverrides: { [modelKey]: { reserveTokens: 400000, keepRecentTokens: 512 } } };
			const manager = SettingsManager.create(cwd, agentDir, options);
			const expected = { enabled: true, reserveTokens: 400000, keepRecentTokens: 512 };
			const other = { provider: "provider", id: "other" };
			expect(manager.getCompactionSettings(model)).toEqual(expected);
			expect(manager.getCompactionReserveTokens(other)).toBe(1024);
			await manager.reload();
			expect(manager.getCompactionSettings(model)).toEqual(expected);
			manager.setProjectTrusted(false);
			expect(manager.getCompactionSettings(model)).toEqual(expected);
			expect(manager.getCompactionReserveTokens(other)).toBe(8192);
			manager.setProjectTrusted(true);
			expect(manager.getCompactionSettings(model)).toEqual(expected);
			expect(manager.getCompactionReserveTokens(other)).toBe(1024);
			expect(readFileSync(globalPath, "utf8")).toBe(globalJson);
			expect(readFileSync(projectPath, "utf8")).toBe(projectJson);

			manager.setCompactionEnabled(false);
			manager.setProjectSkillPaths(["skills"]);
			await manager.flush();
			expect(manager.getCompactionSettings(model)).toEqual({ ...expected, enabled: false });
			expect(manager.getGlobalSettings().compaction).toEqual({ reserveTokens: 8192, enabled: false });
			expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({
				compaction: { reserveTokens: 8192, enabled: false },
			});
			expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({
				compaction: { reserveTokens: 1024 },
				skills: ["skills"],
			});

			rmSync(globalPath);
			rmSync(projectPath);
			const withoutFiles = SettingsManager.create(cwd, agentDir, options);
			await withoutFiles.reload();
			expect(withoutFiles.getCompactionSettings(model)).toEqual(expected);
			expect(existsSync(globalPath)).toBe(false);
			expect(existsSync(projectPath)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps enabled global and preserves overrides when saving the toggle", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				compaction: { modelOverrides: { [modelKey]: { enabled: false, reserveTokens: 400000 } } },
			}),
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings(model).enabled).toBe(true);
		manager.setCompactionEnabled(false);
		await manager.flush();
		await manager.reload();
		expect(manager.getCompactionSettings(model)).toEqual({ ...defaults, enabled: false, reserveTokens: 400000 });
	});

	describe.each(["reserveTokens", "keepRecentTokens"] as const)("model override %s", (field) => {
		it.each([null, -1, 1.5, "400000", true, {}, [], Number.MAX_SAFE_INTEGER + 1])(
			"reports invalid token values: %j",
			(value) => {
				const storage = new InMemorySettingsStorage();
				storage.withLock("global", () =>
					JSON.stringify({
						compaction: { modelOverrides: { [modelKey]: { [field]: value } } },
					}),
				);
				const manager = SettingsManager.fromStorage(storage);
				expect(() => manager.getCompactionSettings(model)).toThrow(
					`Invalid compaction.modelOverrides["${modelKey}"].${field} setting: ${String(value)}. Expected a non-negative safe integer.`,
				);
				expect(manager.getCompactionSettings()).toEqual(defaults);
				expect(manager.getCompactionSettings({ provider: "other", id: model.id })).toEqual(defaults);
			},
		);

		it.each([Number.NaN, Infinity, -Infinity])("reports non-finite runtime values: %s", (value) => {
			const manager = SettingsManager.inMemory();
			manager.applyOverrides({ compaction: { modelOverrides: { [modelKey]: { [field]: value } } } });
			expect(() => manager.getCompactionSettings(model)).toThrow(
				`Invalid compaction.modelOverrides["${modelKey}"].${field} setting: ${String(value)}`,
			);
		});
	});

	describe.each(["reserveTokens", "keepRecentTokens"] as const)("ordinary compaction.%s", (field) => {
		it.each([null, -1, 1.5, "400000", true, {}, [], Number.MAX_SAFE_INTEGER + 1])(
			"reports invalid values even when a valid model override exists: %j",
			(value) => {
				const storage = new InMemorySettingsStorage();
				storage.withLock("global", () =>
					JSON.stringify({
						compaction: {
							[field]: value,
							modelOverrides: { [modelKey]: { [field]: 4096 } },
						},
					}),
				);
				const manager = SettingsManager.fromStorage(storage);
				const error = `Invalid compaction.${field} setting: ${String(value)}. Expected a non-negative safe integer.`;
				expect(() => manager.getCompactionSettings()).toThrow(error);
				expect(() => manager.getCompactionSettings(model)).toThrow(error);
			},
		);

		it.each([Number.NaN, Infinity, -Infinity])("reports non-finite runtime values: %s", (value) => {
			const manager = SettingsManager.inMemory();
			manager.applyOverrides({ compaction: { [field]: value } });
			expect(() => manager.getCompactionSettings()).toThrow(`Invalid compaction.${field} setting: ${String(value)}`);
		});
	});

	it.each([null, false, 42, "invalid", []])("reports malformed model entries: %j", (entry) => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ compaction: { modelOverrides: { [modelKey]: entry } } }));
		expect(() => SettingsManager.fromStorage(storage).getCompactionSettings(model)).toThrow(
			`Invalid compaction.modelOverrides["${modelKey}"] setting: ${String(entry)}. Expected an object.`,
		);
	});

	it("accepts zero in ordinary settings and model overrides", () => {
		const manager = SettingsManager.inMemory({
			compaction: { reserveTokens: 0, keepRecentTokens: 0 },
		});
		expect(manager.getCompactionSettings(model)).toEqual({ enabled: true, reserveTokens: 0, keepRecentTokens: 0 });
		manager.applyOverrides({
			compaction: {
				reserveTokens: 1000,
				keepRecentTokens: 1000,
				modelOverrides: { [modelKey]: { reserveTokens: 0, keepRecentTokens: 0 } },
			},
		});
		expect(manager.getCompactionSettings(model)).toEqual({ enabled: true, reserveTokens: 0, keepRecentTokens: 0 });
	});
});
