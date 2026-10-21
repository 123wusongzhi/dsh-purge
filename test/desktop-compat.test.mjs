import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ALL_PATCHES, applyReplacementsToText, enumeratePatchAiBases } from "../lib/core.js";
import { hostPromptKeepsInject } from "../lib/host-clean.js";
import { rewritePromptAssembly } from "../lib/identity.js";

const currentAssembly = `// system-prompt/assemble
async function assemble(completeSection, runtimeContextSuppressed, contextByName, transformed) {
  if (completeSection === void 0 && !runtimeContextSuppressed) return transformed;
  const requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));
  return {
    ...transformed,
    sections: completeSection === void 0 ? transformed.sections : [completeSection],
    contexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts
  };
}`;

test("current desktop complete prompts keep injected sections and required runtime context", async () => {
  const patch = ALL_PATCHES.find((entry) => entry.id === 40);
  const result = applyReplacementsToText(currentAssembly, patch, "index.js");
  assert.equal(result.changed, true);
  assert.equal(applyReplacementsToText(result.text, patch, "index.js").changed, false);
  assert.equal(hostPromptKeepsInject(result.text), true);
  const assemble = new Function(`return (${result.text.slice(result.text.indexOf("async function"))})`)();
  const complete = { name: "persona", text: "before" };
  const transformed = {
    sections: [{ name: "dsh-purge", text: "fixture" }, { name: "persona", text: "after" }, { name: "tail", text: "tail" }],
    contexts: [{ name: "cwd", text: "fixture directory" }, { name: "optional", text: "optional" }],
    variables: { provider: "fixture", model: "fixture" },
    tools: [],
  };
  const contexts = new Map([["cwd", { name: "cwd", required: true }], ["optional", { name: "optional" }]]);
  for (const suppressed of [false, true]) {
    const output = await assemble(complete, suppressed, contexts, transformed);
    assert.deepEqual(output.sections.map((entry) => entry.name), ["dsh-purge", "persona", "tail"]);
    assert.equal(output.sections[1].text, "after");
    assert.deepEqual(output.contexts.map((entry) => entry.name), suppressed ? ["cwd"] : ["cwd", "optional"]);
    assert.equal(output.variables, transformed.variables);
    const ordinary = await assemble(undefined, suppressed, contexts, transformed);
    assert.equal(ordinary.sections, transformed.sections);
  }
  assert.equal(complete.text, "before");
  const crlf = currentAssembly.replace(/\n/g, "\r\n");
  assert.equal(applyReplacementsToText(crlf, patch, "index.js").changed, true);
});

test("identity overlay does not invent an unregistered cwd prompt variable", () => {
  for (const sections of [[], [{ name: "deployment:persona-suffix", text: "Your working directory is {{cwd}}." }]]) {
    const output = rewritePromptAssembly({ sections, contexts: [], tools: [], variables: { provider: "fixture", model: "fixture" } }, "", { capabilityProtocol: false });
    assert.ok(output.sections.every((section) => section.interpolate === false || !section.text.includes("{{cwd}}")));
  }
});

test("desktop patch discovery excludes a separate Web install even with DSH_BASE set", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-scope-"));
  const keys = ["DSH_HOME", "DSH_SURFACE", "DSH_DESKTOP_INSTALL", "DSH_BASE"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    const install = path.join(root, "DeepSeek Harness");
    const desktopBase = path.join(install, "resources", "app", "dsh", "node_modules", "@deepseek-ai");
    const webBase = path.join(root, "web", "node_modules", "@deepseek-ai");
    for (const base of [desktopBase, webBase]) fs.mkdirSync(path.join(base, "dsh-agent-instructions", "lib"), { recursive: true });
    fs.writeFileSync(path.join(install, "DeepSeek Harness.exe"), "fixture, never executed");
    process.env.DSH_HOME = path.join(root, "home");
    process.env.DSH_SURFACE = "desktop";
    process.env.DSH_DESKTOP_INSTALL = install;
    process.env.DSH_BASE = webBase;
    assert.deepEqual(enumeratePatchAiBases({ discover: true }), [desktopBase]);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
