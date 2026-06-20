import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from './logger';

describe('Guarded Logger', () => {
  let consoleDebugSpy: any;
  let consoleInfoSpy: any;
  let consoleWarnSpy: any;
  let consoleErrorSpy: any;
  const originalProd = import.meta.env.PROD;

  beforeEach(() => {
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Reset import.meta.env.PROD to original value
    // @ts-ignore
    import.meta.env.PROD = originalProd;
  });

  describe('when in development (PROD is false)', () => {
    beforeEach(() => {
      // @ts-ignore
      import.meta.env.PROD = false;
    });

    it('should call console.debug when logger.debug is called', () => {
      logger.debug('test debug', { data: 123 });
      expect(consoleDebugSpy).toHaveBeenCalledWith('test debug', { data: 123 });
    });

    it('should call console.info when logger.info is called', () => {
      logger.info('test info', 'extra');
      expect(consoleInfoSpy).toHaveBeenCalledWith('test info', 'extra');
    });

    it('should call console.warn when logger.warn is called', () => {
      logger.warn('test warn');
      expect(consoleWarnSpy).toHaveBeenCalledWith('test warn');
    });

    it('should call console.error when logger.error is called', () => {
      logger.error('test error');
      expect(consoleErrorSpy).toHaveBeenCalledWith('test error');
    });
  });

  describe('when in production (PROD is true)', () => {
    beforeEach(() => {
      // @ts-ignore
      import.meta.env.PROD = true;
    });

    it('should NOT call console.debug when logger.debug is called', () => {
      logger.debug('test debug');
      expect(consoleDebugSpy).not.toHaveBeenCalled();
    });

    it('should NOT call console.info when logger.info is called', () => {
      logger.info('test info');
      expect(consoleInfoSpy).not.toHaveBeenCalled();
    });

    it('should NOT call console.warn when logger.warn is called', () => {
      logger.warn('test warn');
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('should NOT call console.error when logger.error is called', () => {
      logger.error('test error');
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
