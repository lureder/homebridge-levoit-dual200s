import { CharacteristicValue } from 'homebridge';
import { getErrorMessage } from './errorMessage';

/**
 * Prevents rapid repeated set calls (e.g., HomeKit slider dragging).
 */

const timers = new Map<string, NodeJS.Timeout>();
const pendingValues = new Map<string, number>();

const DEBOUNCE_DELAY_MS = 300;

export function debounceSet(
  uuid: string,
  value: number | CharacteristicValue,
  callback: (finalValue: number) => Promise<void> | void,
  logger?: (message: string) => void,
): void {
  const roundedValue = Math.round(Number(value));
  pendingValues.set(uuid, roundedValue);

  const existing = timers.get(uuid);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(async () => {
    timers.delete(uuid);

    const finalValue = pendingValues.get(uuid);
    pendingValues.delete(uuid);

    if (finalValue === undefined) {
      return;
    }

    try {
      await callback(finalValue);
    } catch (err) {
      if (logger) {
        logger(
          `[DEBOUNCE] Callback failed for ${uuid}: ${getErrorMessage(err)}`,
        );
      }
    }
  }, DEBOUNCE_DELAY_MS);

  timers.set(uuid, timer);
}