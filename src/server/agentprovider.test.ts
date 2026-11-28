import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { agentConfigured, agentProvider, setAgentModel } from "./agent.js";

const NAMES = ["AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_API_KEY", "AGENT_MODEL"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of NAMES) { saved[name] = process.env[name]; delete process.env[name]; }
  setAgentModel();
});
afterEach(() => {
  for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
});

test("with no key the assistant is off", () => {
  assert.equal(agentProvider(), null);
  assert.equal(agentConfigured(), false);
});

test("an OpenAI-style provider needs the URL, the key and the model", () => {
  process.env.OPENAI_COMPATIBLE_BASE_URL = "https://ai.example.test/v1/";
  process.env.OPENAI_COMPATIBLE_API_KEY = "test-key";
  assert.equal(agentProvider(), null);
  assert.equal(agentConfigured(), false);
  process.env.AGENT_MODEL = "  ";
  assert.equal(agentProvider(), null);
  process.env.AGENT_MODEL = "maker/some-model";
  assert.equal(agentProvider(), "compatible");
  assert.equal(agentConfigured(), true);
  delete process.env.OPENAI_COMPATIBLE_API_KEY;
  assert.equal(agentProvider(), null);
});

test("the gateway or Anthropic key wins when it is set too", () => {
  process.env.OPENAI_COMPATIBLE_BASE_URL = "https://ai.example.test/v1";
  process.env.OPENAI_COMPATIBLE_API_KEY = "test-key";
  process.env.AGENT_MODEL = "maker/some-model";
  process.env.ANTHROPIC_API_KEY = "test-key";
  assert.equal(agentProvider(), "anthropic");
  process.env.AI_GATEWAY_API_KEY = "test-key";
  assert.equal(agentProvider(), "gateway");
  assert.equal(agentConfigured(), true);
});
