/**
 * Runtime configuration — persistent feature toggles that can be flipped from
 * the dashboard at runtime without a restart or editing .env. Backed by a
 * small JSON file next to the project root so it survives redeploys.
 *
 * Currently hosts the "experimental" feature flags. Keep this tiny: anything
 * that needs a restart should stay in config.js / .env.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, '..', 'runtime-config.json');

export const DEFAULT_IDENTITY_PROMPTS = {
  anthropic: 'The assistant should identify as {model}, a large language model created by Anthropic. When asked about identity or model name, answer that the assistant is {model}, made by Anthropic.',
  openai:    'The assistant should identify as {model}, a large language model created by OpenAI. When asked about identity, answer that the assistant is {model}, made by OpenAI.',
  google:    'The assistant should identify as {model}, a large language model created by Google. When asked about identity, answer that the assistant is {model}, made by Google.',
  deepseek:  'The assistant should identify as {model}, a large language model created by DeepSeek. When asked about identity, answer that the assistant is {model}, made by DeepSeek.',
  xai:       'The assistant should identify as {model}, a large language model created by xAI. When asked about identity, answer that the assistant is {model}, made by xAI.',
  alibaba:   'The assistant should identify as {model}, a large language model created by Alibaba. When asked about identity, answer that the assistant is {model}, made by Alibaba.',
  moonshot:  'The assistant should identify as {model}, a large language model created by Moonshot AI. When asked about identity, answer that the assistant is {model}, made by Moonshot AI.',
  zhipu:     'The assistant should identify as {model}, a large language model created by Zhipu AI. When asked about identity, answer that the assistant is {model}, made by Zhipu AI.',
  minimax:   'The assistant should identify as {model}, a large language model created by MiniMax. When asked about identity, answer that the assistant is {model}, made by MiniMax.',
  windsurf:  'The assistant should identify as {model}, a coding assistant model by Windsurf. When asked about identity, answer that the assistant is {model}, made by Windsurf.',
};

export const DEFAULT_PROMPT_INJECTION = {
  languageHint: {
    enabled: true,
    applyTo: 'direct_user_only',
    templates: {
      zh: '[Response language: Chinese.]',
      ja: '[Response language: Japanese.]',
      ko: '[Response language: Korean.]',
    },
  },
  anthropicMessages: {
    suppressTextWithToolUse: true,
    claudeCodeSafeMode: true,
    disableIdentityPrompt: true,
  },
  conversationWrapper: {
    enabled: true,
    content: 'The following is a multi-turn conversation. Use relevant prior turns when answering the latest request.\n\n{history}\n\n<human>\n{latest}\n</human>',
  },
  toolProtocol: {
    enabled: true,
    userHeader: `---
[Tool-calling context for this request]

The caller provided the following function definitions for this request. To request a function call, output a block in this exact format:

<tool_call>{"name":"<function_name>","arguments":{...}}</tool_call>

Rules:
1. Each <tool_call>...</tool_call> block must fit on ONE line (no line breaks inside the JSON).
2. "arguments" must be a JSON object matching the function's schema below.
3. You MAY emit MULTIPLE <tool_call> blocks if the request requires calling several functions in parallel (e.g. checking weather in three cities → three separate <tool_call> blocks, one per city). Emit ALL needed calls consecutively, then STOP.
4. After emitting the last <tool_call> block, STOP. Do not write any explanation after it. The caller executes all functions and returns results as <tool_result tool_call_id="...">...</tool_result> in the next user turn.
5. Only call a function if the request genuinely needs it. If you can answer directly from knowledge, do so in plain text without any tool_call.
6. If a listed function is the appropriate way to answer, request that function call using the format above.

Functions:`,
    userFooter: `---
[End tool-calling context]

Now respond to the user request above. Use <tool_call> if appropriate, otherwise answer directly.`,
    systemHeader: `The following functions are available through the client adapter for this request. To request a function call, emit a block in this exact format:

<tool_call>{"name":"<function_name>","arguments":{...}}</tool_call>

Rules:
1. Each <tool_call>...</tool_call> block must fit on ONE line (no line breaks inside the JSON).
2. "arguments" must be a JSON object matching the function's parameter schema.
3. You MAY emit MULTIPLE <tool_call> blocks if the request requires calling several functions in parallel. Emit ALL needed calls consecutively, then STOP generating.
4. After emitting the last <tool_call> block, STOP. Do not write any explanation after it. The caller executes the functions and returns results wrapped in <tool_result tool_call_id="...">...</tool_result> tags in the next user turn.
5. Use this function-call format when a listed function is the appropriate way to satisfy the request.`,
    suffixes: {
      auto: '6. When a function is relevant to the user\'s request, prefer a function call over guessing.',
      required: '6. A function call is required for this request; output at least one <tool_call> block.',
      none: '6. Function calls are disabled for this request; answer directly in plain text.',
    },
    forceFunctionTemplate: '7. Request the function "{name}" for this turn.',
  },
  cascadeSections: {
    withTools: {
      additionalInstructions: {
        enabled: true,
        content: '{toolPreamble}{reinforcement}',
      },
      additionalReinforcement: {
        enabled: true,
        content: 'When the user request is best answered by one of the listed functions, emit the corresponding <tool_call> block and wait for the caller to return the result.',
      },
      toolCallingSection: {
        enabled: true,
        content: '{toolPreamble}',
      },
      communicationSection: {
        enabled: true,
        content: 'The assistant is accessed through an API adapter with the tool-calling capabilities described above. Keep server-side runtime details private, including file paths, hostnames, environment variables, process details, and network configuration. If asked about infrastructure details, say that the assistant cannot disclose infrastructure details.',
      },
    },
    noTools: {
      toolCallingSection: {
        enabled: true,
        content: 'No callable tools are available in this model turn.',
      },
      additionalInstructions: {
        enabled: true,
        content: 'No callable functions are available in this model turn. Answer from the user request, prior conversation, and any content already included in the prompt. If the request includes webpage text, search results, tool outputs, logs, document excerpts, or image descriptions, analyze that provided content normally.',
      },
      communicationSection: {
        enabled: true,
        content: 'The assistant is accessed through an API adapter. It can analyze content included in the request, including webpage text, search results, tool outputs, logs, document excerpts, and image descriptions. Keep server-side runtime details private, including file paths, hostnames, environment variables, process details, and network configuration.',
      },
    },
  },
};

const DEFAULTS = {
  experimental: {
    cascadeConversationReuse: true,
    modelIdentityPrompt: true,
    preflightRateLimit: false,
  },
  identityPrompts: { ...DEFAULT_IDENTITY_PROMPTS },
  promptInjection: structuredClone(DEFAULT_PROMPT_INJECTION),
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    // Skip prototype-polluting keys
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(base[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let _state = structuredClone(DEFAULTS);

function load() {
  if (!existsSync(FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf-8'));
    _state = deepMerge(DEFAULTS, raw);
  } catch (e) {
    log.warn(`runtime-config: failed to load ${FILE}: ${e.message}`);
  }
}

function persist() {
  try {
    writeFileSync(FILE, JSON.stringify(_state, null, 2));
  } catch (e) {
    log.warn(`runtime-config: failed to persist: ${e.message}`);
  }
}

load();

export function getRuntimeConfig() {
  return structuredClone(_state);
}

export function getExperimental() {
  return { ...(_state.experimental || {}) };
}

export function isExperimentalEnabled(key) {
  return !!_state.experimental?.[key];
}

export function setExperimental(patch) {
  if (!patch || typeof patch !== 'object') return getExperimental();
  _state.experimental = { ...(_state.experimental || {}), ...patch };
  for (const k of Object.keys(_state.experimental)) {
    _state.experimental[k] = !!_state.experimental[k];
  }
  persist();
  return getExperimental();
}

export function getIdentityPrompts() {
  return { ...DEFAULT_IDENTITY_PROMPTS, ...(_state.identityPrompts || {}) };
}

export function getIdentityPromptFor(provider) {
  const all = getIdentityPrompts();
  return all[provider] || null;
}

export function setIdentityPrompts(patch) {
  if (!patch || typeof patch !== 'object') return getIdentityPrompts();
  const current = _state.identityPrompts || {};
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v !== 'string') continue;
    current[k] = v.trim();
  }
  _state.identityPrompts = current;
  persist();
  return getIdentityPrompts();
}

export function resetIdentityPrompt(provider) {
  if (provider && _state.identityPrompts) {
    delete _state.identityPrompts[provider];
  } else {
    _state.identityPrompts = {};
  }
  persist();
  return getIdentityPrompts();
}

function normalizePromptInjectionConfig(cfg) {
  const merged = deepMerge(DEFAULT_PROMPT_INJECTION, cfg || {});
  const lang = merged.languageHint || {};
  const applyTo = ['direct_user_only', 'latest_user'].includes(lang.applyTo)
    ? lang.applyTo
    : DEFAULT_PROMPT_INJECTION.languageHint.applyTo;

  const templates = { ...DEFAULT_PROMPT_INJECTION.languageHint.templates };
  if (lang.templates && typeof lang.templates === 'object') {
    for (const key of ['zh', 'ja', 'ko']) {
      if (typeof lang.templates[key] === 'string') templates[key] = lang.templates[key];
    }
  }

  const section = (value, fallback) => ({
    enabled: value?.enabled !== false,
    content: typeof value?.content === 'string' ? value.content : fallback.content,
  });
  const textValue = (value, fallback) => typeof value === 'string' ? value : fallback;

  return {
    languageHint: {
      enabled: lang.enabled !== false,
      applyTo,
      templates,
    },
    anthropicMessages: {
      suppressTextWithToolUse: merged.anthropicMessages?.suppressTextWithToolUse !== false,
      claudeCodeSafeMode: merged.anthropicMessages?.claudeCodeSafeMode !== false,
      disableIdentityPrompt: merged.anthropicMessages?.disableIdentityPrompt !== false,
    },
    conversationWrapper: section(merged.conversationWrapper, DEFAULT_PROMPT_INJECTION.conversationWrapper),
    toolProtocol: {
      enabled: merged.toolProtocol?.enabled !== false,
      userHeader: textValue(merged.toolProtocol?.userHeader, DEFAULT_PROMPT_INJECTION.toolProtocol.userHeader),
      userFooter: textValue(merged.toolProtocol?.userFooter, DEFAULT_PROMPT_INJECTION.toolProtocol.userFooter),
      systemHeader: textValue(merged.toolProtocol?.systemHeader, DEFAULT_PROMPT_INJECTION.toolProtocol.systemHeader),
      suffixes: {
        auto: textValue(merged.toolProtocol?.suffixes?.auto, DEFAULT_PROMPT_INJECTION.toolProtocol.suffixes.auto),
        required: textValue(merged.toolProtocol?.suffixes?.required, DEFAULT_PROMPT_INJECTION.toolProtocol.suffixes.required),
        none: textValue(merged.toolProtocol?.suffixes?.none, DEFAULT_PROMPT_INJECTION.toolProtocol.suffixes.none),
      },
      forceFunctionTemplate: textValue(merged.toolProtocol?.forceFunctionTemplate, DEFAULT_PROMPT_INJECTION.toolProtocol.forceFunctionTemplate),
    },
    cascadeSections: {
      withTools: {
        additionalInstructions: section(merged.cascadeSections?.withTools?.additionalInstructions, DEFAULT_PROMPT_INJECTION.cascadeSections.withTools.additionalInstructions),
        additionalReinforcement: section(merged.cascadeSections?.withTools?.additionalReinforcement, DEFAULT_PROMPT_INJECTION.cascadeSections.withTools.additionalReinforcement),
        toolCallingSection: section(merged.cascadeSections?.withTools?.toolCallingSection, DEFAULT_PROMPT_INJECTION.cascadeSections.withTools.toolCallingSection),
        communicationSection: section(merged.cascadeSections?.withTools?.communicationSection, DEFAULT_PROMPT_INJECTION.cascadeSections.withTools.communicationSection),
      },
      noTools: {
        toolCallingSection: section(merged.cascadeSections?.noTools?.toolCallingSection, DEFAULT_PROMPT_INJECTION.cascadeSections.noTools.toolCallingSection),
        additionalInstructions: section(merged.cascadeSections?.noTools?.additionalInstructions, DEFAULT_PROMPT_INJECTION.cascadeSections.noTools.additionalInstructions),
        communicationSection: section(merged.cascadeSections?.noTools?.communicationSection, DEFAULT_PROMPT_INJECTION.cascadeSections.noTools.communicationSection),
      },
    },
  };
}

export function getPromptInjectionConfig() {
  return normalizePromptInjectionConfig(_state.promptInjection);
}

export function setPromptInjectionConfig(patch) {
  if (!patch || typeof patch !== 'object') return getPromptInjectionConfig();
  _state.promptInjection = normalizePromptInjectionConfig(
    deepMerge(getPromptInjectionConfig(), patch)
  );
  persist();
  return getPromptInjectionConfig();
}

export function resetPromptInjectionConfig() {
  _state.promptInjection = structuredClone(DEFAULT_PROMPT_INJECTION);
  persist();
  return getPromptInjectionConfig();
}
