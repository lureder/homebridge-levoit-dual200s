import { Logger } from 'homebridge';

/**
 * DebugMode utility for conditional debug logging.
 * Logs only when debug mode is enabled in plugin config.
 */
export default class DebugMode {
  constructor(
    private readonly enabled: boolean,
    private readonly log: Logger,
  ) {}

  public debug(...message: any[]): void {
    if (!this.enabled) {
      return;
    }

    this.log.info(`[DEBUG] ${message.join(' ')}`);
  }
}