import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Hello World', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should log Hello World', async () => {
    const consoleSpy = vi.spyOn(console, 'log');

    await import('./index');

    expect(consoleSpy).toHaveBeenCalledWith('Hello World');
    consoleSpy.mockRestore();
  });
});
