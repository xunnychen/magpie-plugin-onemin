import { readFileSync } from 'node:fs';
import {
  COMPAT_BASE,
  PROVIDER_ID,
  createBridge,
  listModels,
} from './lib/onemin.mjs';

const ICON = `data:image/svg+xml;base64,${readFileSync(
  new URL('./onemin.svg', import.meta.url),
).toString('base64')}`;

const PROVIDER_DEFAULTS = {
  npm: '@ai-sdk/openai-compatible',
  name: '1min.AI',
  // the bridge keeps the path /openai/v1 answers; what the vendor is
  // reached at decides nothing, as every request is rewritten
  options: { baseURL: COMPAT_BASE },
  models: {},
};

const keyPrompt = {
  type: 'password',
  key: 'apiKey',
  message: '1min.AI API key',
  placeholder: '粘贴 1min.AI API key / Paste the API key',
};

const plugin = async (input = {}) => ({
  config: async (config) => {
    config.provider ??= {};
    const existing = config.provider[PROVIDER_ID] ?? {};
    config.provider[PROVIDER_ID] = {
      ...PROVIDER_DEFAULTS,
      ...existing,
      npm: existing.npm ?? PROVIDER_DEFAULTS.npm,
      name: existing.name ?? PROVIDER_DEFAULTS.name,
      options: {
        ...PROVIDER_DEFAULTS.options,
        ...(existing.options ?? {}),
        baseURL: existing.options?.baseURL ?? COMPAT_BASE,
      },
      models: {
        ...PROVIDER_DEFAULTS.models,
        ...(existing.models ?? {}),
      },
    };
  },

  auth: {
    provider: PROVIDER_ID,
    methods: [
      {
        type: 'api',
        label: '1min.AI API key',
        prompts: [keyPrompt],
        async authorize(inputs = {}) {
          if (typeof inputs.apiKey !== 'string' || inputs.apiKey.trim() === '') {
            return { type: 'failed', error: '请输入 1min.AI API key / Enter a 1min.AI API key.' };
          }
          return { type: 'success', key: inputs.apiKey.trim() };
        },
      },
    ],
    icon: ICON,
    options: [
      {
        key: 'tool-emulation',
        label: 'Emulate tool calls',
        labels: { zh: '模拟工具调用', 'zh-TW': '模擬工具呼叫' },
        description:
          '1min chat has no tool protocol: the tools are described in the prompt and the call is read back out of the reply.',
        descriptions: {
          zh: '1min 的 chat 接口没有工具协议：工具会在提示词里说明，调用再从回复里解析出来。',
          'zh-TW': '1min 的 chat 介面沒有工具協定：工具會在提示詞裡說明，呼叫再從回覆裡解析出來。',
        },
        default: true,
      },
    ],
    async loader(getAuth, providerConfig = {}) {
      const auth = await getAuth();
      const apiKey = typeof auth?.key === 'string' ? auth.key.trim() : '';
      if (!apiKey) throw new Error('1min.AI API key is missing.');
      const option = input?.magpie?.option;
      const toolEmulation =
        typeof option === 'function' ? option(PROVIDER_ID, 'tool-emulation') !== false : true;
      return {
        apiKey,
        baseURL: providerConfig.options?.baseURL ?? COMPAT_BASE,
        fetch: createBridge({ apiKey, toolEmulation }),
      };
    },
  },

  provider: {
    id: PROVIDER_ID,
    async models(provider, { auth, signal } = {}) {
      const option = input?.magpie?.option;
      const toolEmulation =
        typeof option === 'function' ? option(PROVIDER_ID, 'tool-emulation') !== false : true;
      const apiKey = typeof auth?.key === 'string' ? auth.key.trim() : '';
      const existing = provider?.models ?? {};
      if (!apiKey) return existing;
      try {
        return await listModels({ apiKey, toolEmulation, signal });
      } catch {
        // a listing that fails keeps whatever was known: the editor still
        // shows the models, and the next fetch replaces them
        return existing;
      }
    },
  },
});

export default plugin;
