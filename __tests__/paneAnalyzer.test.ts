import { describe, expect, it, vi } from 'vitest';
import { normalizePaneContentForAnalysis, PaneAnalyzer } from '../src/services/PaneAnalyzer.js';
import { LogService } from '../src/services/LogService.js';

vi.mock('../src/utils/settingsManager.js', () => ({
  SettingsManager: class {
    getSettings() { return {}; }
    getGlobalSettings() { return {}; }
    getProjectSettings() { return {}; }
  },
}));

describe('PaneAnalyzer content normalization', () => {
  it('keeps only the last 50 lines after trimming blank edges', () => {
    const content = [
      '',
      '',
      ...Array.from({ length: 55 }, (_, index) => `line ${index + 1}`),
      '',
      '',
    ].join('\n');

    expect(normalizePaneContentForAnalysis(content).split('\n')).toEqual(
      Array.from({ length: 50 }, (_, index) => `line ${index + 6}`)
    );
  });

  it('drops blank boundary lines left after slicing the final window', () => {
    const content = [
      'discard me',
      '',
      ...Array.from({ length: 49 }, (_, index) => `keep ${index + 1}`),
    ].join('\n');

    expect(normalizePaneContentForAnalysis(content).split('\n')).toEqual(
      Array.from({ length: 49 }, (_, index) => `keep ${index + 1}`)
    );
  });

  it('falls back to free status models when preferred OpenRouter models fail', async () => {
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key';
    LogService.getInstance().setSuppressConsole(true);

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const model = body.model;

      if (model === 'google/gemini-2.5-flash' || model === 'openai/gpt-4o-mini') {
        return new Response(
          JSON.stringify({ error: { message: 'Key limit exceeded', code: 403 } }),
          { status: 403 }
        );
      }

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"state":"open_prompt"}' } }],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const analyzer = new PaneAnalyzer();
      await expect(analyzer.determineState('Task complete.\n> ')).resolves.toBe('open_prompt');

      const requestedModels = fetchMock.mock.calls.map(([, init]) => {
        const body = JSON.parse(String(init?.body || '{}'));
        return body.model;
      });
      expect(requestedModels).toContain('openai/gpt-oss-120b:free');
      expect(requestedModels).not.toContain('x-ai/grok-4-fast:free');
    } finally {
      vi.unstubAllGlobals();
      LogService.getInstance().setSuppressConsole(false);
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
    }
  });
});
