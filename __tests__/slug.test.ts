import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  generateLocalSlugFromPrompt,
  generateSlug,
  normalizeSlugCandidate,
} from '../src/utils/slug.js';

vi.mock('../src/services/InferenceService.js', () => ({
  generateInferenceText: vi.fn(() => Promise.reject(new Error('no inference provider configured'))),
}));

let originalOpenRouterApiKey: string | undefined;

describe('slug generation', () => {
  beforeEach(() => {
    originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    if (originalOpenRouterApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
    }
  });

  it('falls back to a readable date when there is no prompt', async () => {
    const slug = await generateSlug('');
    expect(slug).toMatch(/^dmux-\d{4}-\d{2}-\d{2}-\d{6}$/);
  });

  it('uses significant prompt words when no provider is configured', async () => {
    const slug = await generateSlug('Refactor Dmux App');
    expect(slug).toBe('refactor-dmux-app');
  });

  it('builds a local slug from repeated significant words', () => {
    expect(generateLocalSlugFromPrompt('Fix auth auth redirects after login')).toBe(
      'fix-auth-redirects-login'
    );
  });

  it('normalizes provider output into kebab case', () => {
    expect(normalizeSlugCandidate('Fix Auth\nextra text')).toBe('fix-auth');
  });
});
